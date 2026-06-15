-- ============================================================
-- 019_recipe_rebuild_internal_handlers.sql
--
-- Rebuilds the four INTERNAL recipe handlers that were placeholder-disabled
-- in the initial seed:
--   bank_gl_writer          (Bank GL Writer)
--   cc_gl_writer            (Credit Card GL Writer)
--   payroll_gl_writer       (Payroll GL Writer)
--   monthly_close_generator (Monthly Close Checklist Generator)
--
-- All four follow the proven pattern of public.gl_entry_writer:
--   - signature (p_agency_id uuid, p_recipe_id uuid) returns jsonb
--   - jsonb_build_object('records_processed', N, 'output_summary', text)
--   - SECURITY DEFINER
--   - idempotent guards on source-table flags / journal_entry_id
--
-- Period semantics for monthly_close_generator are aligned with the live
-- monthly_close_monitor: period_year/period_month = the month when close
-- work is performed (e.g., closing May happens in early June, so period_month=6).
-- The doc_label is decorated with the closing month for readability.
--
-- Author: Project Claude (this Claude instance), 2026-06-15
-- Applied via Supabase MCP apply_migration:
--   recipe_rebuild_internal_handlers
--   monthly_close_generator_period_semantics_fix
-- ============================================================

-- ------------------------------------------------------------
-- 0. Suspense accounts for "never_fail_to_post" semantics
-- ------------------------------------------------------------
INSERT INTO public.chart_of_accounts (agency_id, account_code, account_name, account_type, account_subtype, is_active, is_system)
SELECT '98aa8b9b-92e4-4ebc-8727-aa00ce696fab', '1990', 'Suspense — Unclassified Cash', 'asset', 'current_asset', true, true
WHERE NOT EXISTS (
  SELECT 1 FROM public.chart_of_accounts
  WHERE agency_id='98aa8b9b-92e4-4ebc-8727-aa00ce696fab' AND account_code='1990'
);

INSERT INTO public.chart_of_accounts (agency_id, account_code, account_name, account_type, account_subtype, is_active, is_system)
SELECT '98aa8b9b-92e4-4ebc-8727-aa00ce696fab', '6990', 'Suspense — Unclassified Expense', 'expense', NULL, true, true
WHERE NOT EXISTS (
  SELECT 1 FROM public.chart_of_accounts
  WHERE agency_id='98aa8b9b-92e4-4ebc-8727-aa00ce696fab' AND account_code='6990'
);

-- ------------------------------------------------------------
-- 1. bank_gl_writer
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.bank_gl_writer(p_agency_id uuid, p_recipe_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $fn$
DECLARE
  v_cutover_date  DATE;
  v_suspense_id   UUID;
  v_txn           RECORD;
  v_bank_acct_id  UUID;
  v_entry_id      UUID;
  v_abs_amount    NUMERIC;
  v_dr_id         UUID;
  v_cr_id         UUID;
  v_count         INTEGER := 0;
  v_now           TIMESTAMPTZ := NOW();
BEGIN
  SELECT setting_value::date INTO v_cutover_date
  FROM public.settings
  WHERE agency_id=p_agency_id AND setting_key='gl_cutover_date' LIMIT 1;
  v_cutover_date := COALESCE(v_cutover_date, '2000-01-01'::date);

  SELECT id INTO v_suspense_id
  FROM public.chart_of_accounts
  WHERE agency_id=p_agency_id AND account_code='1990' LIMIT 1;
  IF v_suspense_id IS NULL THEN
    RETURN jsonb_build_object('records_processed', 0,
      'output_summary', 'Skipped: 1990 Suspense account not found');
  END IF;

  FOR v_txn IN
    SELECT bt.id, bt.txn_date, bt.description, bt.amount, bt.counterparty,
           bt.account_id AS bank_coa_account_id, bam.account_id AS mapped_coa_id
    FROM public.bank_transactions bt
    LEFT JOIN public.bank_account_mapping bam ON bam.id = bt.bank_account_mapping_id
    WHERE bt.agency_id = p_agency_id
      AND COALESCE(bt.is_pre_cutover, bt.txn_date <= v_cutover_date) = false
      AND COALESCE(bt.is_posted_to_gl, false) = false
      AND bt.journal_entry_id IS NULL
      AND bt.amount IS NOT NULL AND bt.amount <> 0
    ORDER BY bt.txn_date, bt.id
  LOOP
    v_bank_acct_id := COALESCE(v_txn.bank_coa_account_id, v_txn.mapped_coa_id);
    IF v_bank_acct_id IS NULL THEN CONTINUE; END IF;

    INSERT INTO public.journal_entries (
      agency_id, entry_date, entry_type, source, reference_number, description, memo, created_by, created_at
    ) VALUES (
      p_agency_id, v_txn.txn_date, 'bank_transaction', 'bank_gl_writer',
      'BANK-' || v_txn.id::text,
      COALESCE(NULLIF(trim(v_txn.description), ''), 'Bank transaction ' || v_txn.txn_date::text),
      'Auto-posted via bank_gl_writer. Suspense-side pending classification.',
      'bank_gl_writer', v_now
    ) RETURNING id INTO v_entry_id;

    v_abs_amount := ABS(v_txn.amount);
    IF v_txn.amount > 0 THEN
      v_dr_id := v_bank_acct_id; v_cr_id := v_suspense_id;
    ELSE
      v_dr_id := v_suspense_id;  v_cr_id := v_bank_acct_id;
    END IF;

    INSERT INTO public.journal_lines (
      journal_entry_id, agency_id, account_id, debit, credit, description, created_at
    ) VALUES
      (v_entry_id, p_agency_id, v_dr_id, v_abs_amount, 0, v_txn.description, v_now),
      (v_entry_id, p_agency_id, v_cr_id, 0, v_abs_amount, v_txn.description, v_now);

    UPDATE public.bank_transactions
    SET is_posted_to_gl = true, journal_entry_id = v_entry_id
    WHERE id = v_txn.id;

    v_count := v_count + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'records_processed', v_count,
    'output_summary', v_count || ' bank transactions posted to GL (suspense side)'
  );
END;
$fn$;

-- ------------------------------------------------------------
-- 2. cc_gl_writer
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cc_gl_writer(p_agency_id uuid, p_recipe_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $fn$
DECLARE
  v_cutover_date    DATE;
  v_suspense_exp_id UUID;
  v_txn             RECORD;
  v_cc_acct_id      UUID;
  v_other_acct_id   UUID;
  v_entry_id        UUID;
  v_abs_amount      NUMERIC;
  v_dr_id           UUID;
  v_cr_id           UUID;
  v_count           INTEGER := 0;
  v_now             TIMESTAMPTZ := NOW();
BEGIN
  SELECT setting_value::date INTO v_cutover_date
  FROM public.settings
  WHERE agency_id=p_agency_id AND setting_key='gl_cutover_date' LIMIT 1;
  v_cutover_date := COALESCE(v_cutover_date, '2000-01-01'::date);

  SELECT id INTO v_suspense_exp_id
  FROM public.chart_of_accounts
  WHERE agency_id=p_agency_id AND account_code='6990' LIMIT 1;
  IF v_suspense_exp_id IS NULL THEN
    RETURN jsonb_build_object('records_processed', 0,
      'output_summary', 'Skipped: 6990 Suspense Expense not found');
  END IF;

  FOR v_txn IN
    SELECT ct.id, ct.transaction_date, ct.description, ct.amount, ct.transaction_type,
           ct.category, ct.credit_account_id
    FROM public.credit_transactions ct
    WHERE ct.agency_id = p_agency_id
      AND ct.transaction_date > v_cutover_date
      AND ct.journal_entry_id IS NULL
      AND ct.amount IS NOT NULL AND ct.amount <> 0
    ORDER BY ct.transaction_date, ct.id
  LOOP
    v_cc_acct_id := v_txn.credit_account_id;
    IF v_cc_acct_id IS NULL THEN CONTINUE; END IF;
    v_other_acct_id := v_suspense_exp_id;

    INSERT INTO public.journal_entries (
      agency_id, entry_date, entry_type, source, reference_number, description, memo, created_by, created_at
    ) VALUES (
      p_agency_id, v_txn.transaction_date, 'credit_transaction', 'cc_gl_writer',
      'CC-' || v_txn.id::text,
      COALESCE(NULLIF(trim(v_txn.description), ''), 'CC transaction ' || v_txn.transaction_date::text),
      'Auto-posted via cc_gl_writer. Expense side pending classification.',
      'cc_gl_writer', v_now
    ) RETURNING id INTO v_entry_id;

    v_abs_amount := ABS(v_txn.amount);
    IF v_txn.amount > 0 THEN
      v_dr_id := v_other_acct_id; v_cr_id := v_cc_acct_id;
    ELSE
      v_dr_id := v_cc_acct_id;    v_cr_id := v_other_acct_id;
    END IF;

    INSERT INTO public.journal_lines (
      journal_entry_id, agency_id, account_id, debit, credit, description, created_at
    ) VALUES
      (v_entry_id, p_agency_id, v_dr_id, v_abs_amount, 0, v_txn.description, v_now),
      (v_entry_id, p_agency_id, v_cr_id, 0, v_abs_amount, v_txn.description, v_now);

    UPDATE public.credit_transactions
    SET journal_entry_id = v_entry_id WHERE id = v_txn.id;
    v_count := v_count + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'records_processed', v_count,
    'output_summary', v_count || ' credit card transactions posted to GL (suspense side)'
  );
END;
$fn$;

-- ------------------------------------------------------------
-- 3. payroll_gl_writer (single_entity convention)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.payroll_gl_writer(p_agency_id uuid, p_recipe_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $fn$
DECLARE
  v_cutover_date  DATE;
  v_cash_id       UUID;
  v_wages_id      UUID;
  v_ertax_id      UUID;
  v_run           RECORD;
  v_entry_id      UUID;
  v_total_cash    NUMERIC;
  v_count         INTEGER := 0;
  v_now           TIMESTAMPTZ := NOW();
BEGIN
  SELECT setting_value::date INTO v_cutover_date
  FROM public.settings
  WHERE agency_id=p_agency_id AND setting_key='gl_cutover_date' LIMIT 1;
  v_cutover_date := COALESCE(v_cutover_date, '2000-01-01'::date);

  SELECT id INTO v_cash_id  FROM public.chart_of_accounts WHERE agency_id=p_agency_id AND account_code='1010' LIMIT 1;
  SELECT id INTO v_wages_id FROM public.chart_of_accounts WHERE agency_id=p_agency_id AND account_code='6000' LIMIT 1;
  SELECT id INTO v_ertax_id FROM public.chart_of_accounts WHERE agency_id=p_agency_id AND account_code='6030' LIMIT 1;

  IF v_cash_id IS NULL OR v_wages_id IS NULL THEN
    RETURN jsonb_build_object('records_processed', 0,
      'output_summary', 'Skipped: required accounts 1010/6000 not found');
  END IF;

  FOR v_run IN
    SELECT id, pay_period_start, pay_period_end, pay_date, payroll_provider,
           gross_payroll, employer_taxes, net_payroll
    FROM public.payroll_runs
    WHERE agency_id = p_agency_id
      AND COALESCE(pay_date, pay_period_end) > v_cutover_date
      AND COALESCE(status, '') NOT IN ('posted','void')
      AND COALESCE(gross_payroll, 0) > 0
    ORDER BY pay_date, id
  LOOP
    v_total_cash := COALESCE(v_run.gross_payroll, 0) + COALESCE(v_run.employer_taxes, 0);
    IF v_total_cash <= 0 THEN CONTINUE; END IF;

    INSERT INTO public.journal_entries (
      agency_id, entry_date, entry_type, source, reference_number, description, memo, created_by, created_at
    ) VALUES (
      p_agency_id, COALESCE(v_run.pay_date, v_run.pay_period_end), 'payroll_run', 'payroll_gl_writer',
      'PAY-' || COALESCE(v_run.pay_date, v_run.pay_period_end)::text || '-' || left(v_run.id::text, 8),
      'Payroll ' || COALESCE(v_run.payroll_provider, '') || ' '
        || COALESCE(v_run.pay_period_start::text, '') || ' through ' || COALESCE(v_run.pay_period_end::text, ''),
      'Gross $' || COALESCE(v_run.gross_payroll, 0)::text
        || '; ER taxes $' || COALESCE(v_run.employer_taxes, 0)::text
        || '; Net to staff $' || COALESCE(v_run.net_payroll, 0)::text,
      'payroll_gl_writer', v_now
    ) RETURNING id INTO v_entry_id;

    INSERT INTO public.journal_lines (journal_entry_id, agency_id, account_id, debit, credit, description, created_at)
    VALUES (v_entry_id, p_agency_id, v_wages_id, v_run.gross_payroll, 0, 'Gross payroll', v_now);

    IF COALESCE(v_run.employer_taxes, 0) > 0 AND v_ertax_id IS NOT NULL THEN
      INSERT INTO public.journal_lines (journal_entry_id, agency_id, account_id, debit, credit, description, created_at)
      VALUES (v_entry_id, p_agency_id, v_ertax_id, v_run.employer_taxes, 0, 'Employer payroll taxes', v_now);
    END IF;

    INSERT INTO public.journal_lines (journal_entry_id, agency_id, account_id, debit, credit, description, created_at)
    VALUES (v_entry_id, p_agency_id, v_cash_id, 0, v_total_cash, 'Total cash out for payroll', v_now);

    UPDATE public.payroll_runs SET status = 'posted' WHERE id = v_run.id;
    v_count := v_count + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'records_processed', v_count,
    'output_summary', v_count || ' payroll runs posted to GL'
  );
END;
$fn$;

-- ------------------------------------------------------------
-- 4. monthly_close_generator
-- Period semantics aligned with monthly_close_monitor:
--   period_year/period_month = month when close work is performed
--   doc_label gets a " (closes MMM YYYY)" suffix for human readability
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.monthly_close_generator(p_agency_id uuid, p_recipe_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $fn$
DECLARE
  v_today          DATE := CURRENT_DATE;
  v_target_year    INT  := EXTRACT(YEAR  FROM v_today)::INT;
  v_target_mo      INT  := EXTRACT(MONTH FROM v_today)::INT;
  v_closing_year   INT;
  v_closing_mo     INT;
  v_first_day      DATE := MAKE_DATE(v_target_year, v_target_mo, 1);
  v_cfg            jsonb;
  v_item           jsonb;
  v_created        INT := 0;
  v_skipped        INT := 0;
  v_offset         INT;
  v_expected       DATE;
  v_label          TEXT;
  v_category       TEXT;
  v_label_decor    TEXT;
BEGIN
  IF v_target_mo = 1 THEN
    v_closing_year := v_target_year - 1; v_closing_mo := 12;
  ELSE
    v_closing_year := v_target_year;     v_closing_mo := v_target_mo - 1;
  END IF;

  SELECT input_config INTO v_cfg FROM public.automation_recipes WHERE id = p_recipe_id;
  IF v_cfg IS NULL OR jsonb_typeof(v_cfg->'items') <> 'array' THEN
    RETURN jsonb_build_object('records_processed', 0,
      'output_summary', 'Skipped: recipe input_config.items missing or not an array');
  END IF;

  v_label_decor := ' (closes ' || TO_CHAR(MAKE_DATE(v_closing_year, v_closing_mo, 1), 'Mon YYYY') || ')';

  FOR v_item IN SELECT jsonb_array_elements(v_cfg->'items')
  LOOP
    v_label    := (v_item->>'doc_label') || v_label_decor;
    v_category := v_item->>'doc_category';
    v_offset   := COALESCE((v_item->>'expected_offset_days')::int, 5);
    v_expected := v_first_day + (v_offset - 1);

    IF EXISTS (
      SELECT 1 FROM public.monthly_close_checklist
      WHERE agency_id = p_agency_id
        AND period_year  = v_target_year
        AND period_month = v_target_mo
        AND doc_label    = v_label
    ) THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    INSERT INTO public.monthly_close_checklist (
      agency_id, period_year, period_month, doc_category, doc_label, expected_by,
      received_at, document_id, status, is_closed, notes, created_at
    ) VALUES (
      p_agency_id, v_target_year, v_target_mo, v_category, v_label, v_expected,
      NULL, NULL, 'pending', false,
      'Closes ' || v_closing_year::text || '-' || lpad(v_closing_mo::text, 2, '0') || '. Generated by monthly_close_generator.',
      NOW()
    );
    v_created := v_created + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'records_processed', v_created,
    'skipped_existing', v_skipped,
    'period_year',  v_target_year,
    'period_month', v_target_mo,
    'closing_year', v_closing_year,
    'closing_month', v_closing_mo,
    'output_summary', v_created || ' checklist items created for ' || v_target_year || '-' || lpad(v_target_mo::text, 2, '0')
      || ' (closes ' || v_closing_year::text || '-' || lpad(v_closing_mo::text, 2, '0') || ', ' || v_skipped || ' already existed)'
  );
END;
$fn$;
