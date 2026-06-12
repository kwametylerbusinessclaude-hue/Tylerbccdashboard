-- =========================================================================
-- MIGRATION 014 — GL Entry Writer Signed-Amount Handling (Chargebacks)
-- =========================================================================
-- The version of gl_entry_writer() shipped in migration 013 inserted the
-- raw `amount` from comp_recap straight into journal_lines.debit/credit.
-- That hits the `debit_credit_check` constraint on journal_lines whenever
-- a comp_recap line has a negative amount (chargeback / clawback /
-- refund), e.g. the FIRE RENEWAL - AMD66 $-0.35 on the 2026-05-15 SF
-- Comp Recap.
--
--   journal_lines constraint:
--     CHECK ((debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0))
--
-- The constraint is correct — every JE line must have exactly one
-- positive side. The fix is to detect negative amounts and FLIP the
-- DR/CR sides, using ABS(amount) on both legs:
--
--   Positive comp_recap.amount: DR cash / CR income  (cash receipt)
--   Negative comp_recap.amount: DR income / CR cash  (chargeback reverses
--                                                     prior recognition)
--
-- The JE total balance stays intact. Net cash movement still matches
-- SUM(signed amounts) — proven on the 2026-05-15 recap, where 13 positive
-- lines + 1 chargeback produced a JE with $21,477.54 DR=CR and a net
-- cash deposit of $21,476.84 (= $21,477.54 minus 2× $0.35 chargeback legs).
--
-- For BENEFITS wash lines, the same flip applies (DR/CR sides swap), so
-- benefit reversals would also book correctly should they ever occur.
--
-- The accumulators (v_total_cash, v_total_wash) keep using the signed
-- amount so the memo reflects net activity, not gross.
--
-- HOW THIS WAS DISCOVERED: the first automated cron run after migration
-- 013 deployed (2026-06-11 16:00 UTC) failed with
--   "new row for relation \"journal_lines\" violates check constraint
--    \"debit_credit_check\""
-- The transaction rolled back cleanly — no partial state. The fix below
-- was applied via apply_migration the same day and the recipe was
-- manually invoked to clear the May 15 + May 31 backlog. The repo file
-- exists so any future re-apply or new-agency install gets the corrected
-- function from the start.
--
-- IDEMPOTENT — CREATE OR REPLACE FUNCTION. Safe to re-run.
-- =========================================================================

CREATE OR REPLACE FUNCTION public.gl_entry_writer(
  p_agency_id UUID,
  p_recipe_id UUID
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
AS $func$
DECLARE
  v_cutover_date    DATE;
  v_cash_acct_name  TEXT;
  v_cash_acct_id    UUID;
  v_fallback_name   TEXT;
  v_fallback_id     UUID;
  v_recap           RECORD;
  v_line            RECORD;
  v_entry_id        UUID;
  v_credit_code     TEXT;
  v_debit_code      TEXT;
  v_is_wash         BOOLEAN;
  v_credit_acct_id  UUID;
  v_debit_acct_id   UUID;
  v_dr_id           UUID;        -- effective DR side after sign handling
  v_cr_id           UUID;        -- effective CR side after sign handling
  v_abs_amount      NUMERIC;
  v_lines_inserted  INTEGER;
  v_total_cash      NUMERIC;
  v_total_wash      NUMERIC;
  v_recap_count     INTEGER := 0;
  v_line_count      INTEGER := 0;
  v_now             TIMESTAMPTZ := NOW();
BEGIN
  SELECT setting_value::date INTO v_cutover_date
  FROM public.settings
  WHERE agency_id=p_agency_id AND setting_key='gl_cutover_date' LIMIT 1;
  v_cutover_date := COALESCE(v_cutover_date, '2000-01-01'::date);

  SELECT setting_value INTO v_cash_acct_name
  FROM public.settings
  WHERE agency_id=p_agency_id AND setting_key='gl_default_cash_account_name' LIMIT 1;
  v_cash_acct_name := COALESCE(v_cash_acct_name, 'Operating Checking Account');

  SELECT id INTO v_cash_acct_id
  FROM public.chart_of_accounts
  WHERE agency_id=p_agency_id AND account_name=v_cash_acct_name LIMIT 1;

  IF v_cash_acct_id IS NULL THEN
    RETURN jsonb_build_object('records_processed', 0,
      'output_summary', 'Skipped: cash account "' || v_cash_acct_name || '" not found');
  END IF;

  SELECT setting_value INTO v_fallback_name
  FROM public.settings
  WHERE agency_id=p_agency_id AND setting_key='gl_default_sf_revenue_account_name' LIMIT 1;
  v_fallback_name := COALESCE(v_fallback_name, 'Miscellaneous Income');

  SELECT id INTO v_fallback_id
  FROM public.chart_of_accounts
  WHERE agency_id=p_agency_id AND account_name=v_fallback_name LIMIT 1;

  FOR v_recap IN
    SELECT DISTINCT recap_date
    FROM public.comp_recap
    WHERE agency_id=p_agency_id
      AND posted_at IS NULL
      AND amount_type='half_month_activity'
      AND recap_date > v_cutover_date
    ORDER BY recap_date
  LOOP
    INSERT INTO public.journal_entries (
      agency_id, entry_date, entry_type, source, reference_number, description, created_by, created_at
    ) VALUES (
      p_agency_id, v_recap.recap_date, 'comp_recap', 'gl_entry_writer',
      'SFCR-' || TO_CHAR(v_recap.recap_date, 'YYYY-MM-DD'),
      'SF Comp Recap ' || TO_CHAR(v_recap.recap_date, 'YYYY-MM-DD'),
      'gl_entry_writer', v_now
    ) RETURNING id INTO v_entry_id;

    v_lines_inserted := 0;
    v_total_cash     := 0;
    v_total_wash     := 0;

    FOR v_line IN
      SELECT id, comp_type, comp_category, description, amount
      FROM public.comp_recap
      WHERE agency_id=p_agency_id
        AND recap_date=v_recap.recap_date
        AND posted_at IS NULL
        AND amount_type='half_month_activity'
        AND amount IS NOT NULL
        AND amount != 0
      ORDER BY line_sequence NULLS LAST, id
    LOOP
      SELECT credit_account_code, debit_account_code, is_benefit_wash
        INTO v_credit_code, v_debit_code, v_is_wash
      FROM public.comp_recap_account_mapping
      WHERE agency_id=p_agency_id
        AND is_active=true
        AND comp_type=v_line.comp_type
        AND (comp_category IS NULL OR comp_category=v_line.comp_category)
        AND (description_pattern IS NULL OR v_line.description ILIKE description_pattern)
      ORDER BY priority ASC,
               (description_pattern IS NULL) ASC,
               (comp_category IS NULL) ASC
      LIMIT 1;

      v_credit_acct_id := NULL;
      IF v_credit_code IS NOT NULL THEN
        SELECT id INTO v_credit_acct_id FROM public.chart_of_accounts
        WHERE agency_id=p_agency_id AND account_code=v_credit_code LIMIT 1;
      END IF;
      IF v_credit_acct_id IS NULL THEN v_credit_acct_id := v_fallback_id; END IF;

      IF v_is_wash AND v_debit_code IS NOT NULL THEN
        SELECT id INTO v_debit_acct_id FROM public.chart_of_accounts
        WHERE agency_id=p_agency_id AND account_code=v_debit_code LIMIT 1;
      ELSE
        v_debit_acct_id := v_cash_acct_id;
      END IF;

      IF v_debit_acct_id IS NULL OR v_credit_acct_id IS NULL THEN CONTINUE; END IF;

      -- Sign handling: chargebacks (negative amounts) reverse the DR/CR sides.
      -- The journal_lines check constraint requires exactly one positive side;
      -- writing a raw negative would violate it. Flipping is also the correct
      -- accounting representation of a chargeback (reverse of original receipt).
      v_abs_amount := ABS(v_line.amount);
      IF v_line.amount >= 0 THEN
        v_dr_id := v_debit_acct_id;
        v_cr_id := v_credit_acct_id;
      ELSE
        v_dr_id := v_credit_acct_id;
        v_cr_id := v_debit_acct_id;
      END IF;

      INSERT INTO public.journal_lines (
        journal_entry_id, agency_id, account_id, debit, credit, description, created_at
      ) VALUES
        (v_entry_id, p_agency_id, v_dr_id, v_abs_amount, 0, v_line.description, v_now),
        (v_entry_id, p_agency_id, v_cr_id, 0, v_abs_amount, v_line.description, v_now);

      v_lines_inserted := v_lines_inserted + 2;
      -- Accumulators use the signed amount so memo totals reflect net cash/wash movement
      IF COALESCE(v_is_wash, false) THEN
        v_total_wash := v_total_wash + v_line.amount;
      ELSE
        v_total_cash := v_total_cash + v_line.amount;
      END IF;

      UPDATE public.comp_recap
      SET posted_at = v_now, journal_entry_id = v_entry_id
      WHERE id = v_line.id;
    END LOOP;

    IF v_lines_inserted = 0 THEN
      DELETE FROM public.journal_entries WHERE id = v_entry_id;
      CONTINUE;
    END IF;

    UPDATE public.journal_entries
    SET memo = 'Cash deposit: $' || v_total_cash::text ||
               CASE WHEN v_total_wash != 0
                    THEN '; Benefits wash: $' || v_total_wash::text ELSE '' END
    WHERE id = v_entry_id;

    UPDATE public.comp_recap
    SET posted_at = v_now
    WHERE agency_id=p_agency_id AND recap_date=v_recap.recap_date AND posted_at IS NULL;

    v_recap_count := v_recap_count + 1;
    v_line_count  := v_line_count + v_lines_inserted;
  END LOOP;

  RETURN jsonb_build_object(
    'records_processed', v_recap_count,
    'lines_inserted', v_line_count,
    'output_summary', v_recap_count || ' recaps posted (' || v_line_count || ' journal lines)'
  );
END;
$func$;

GRANT EXECUTE ON FUNCTION public.gl_entry_writer(UUID, UUID) TO postgres, service_role;


-- =========================================================================
-- VERIFICATION QUERIES (run manually after applying)
-- =========================================================================
--
-- 1) Confirm the function exists and reports the right signature:
--    SELECT pg_get_function_arguments(oid) FROM pg_proc WHERE proname='gl_entry_writer';
--    -- expect: p_agency_id uuid, p_recipe_id uuid
--
-- 2) Smoke test against a small known-balance recap (replace UUIDs):
--    SELECT public.gl_entry_writer(
--      '<agency_uuid>'::uuid,
--      '<recipe_uuid>'::uuid
--    );
--    -- expect: jsonb with records_processed, lines_inserted, output_summary
--
-- 3) Verify each JE balances (DR total = CR total per JE):
--    SELECT je.reference_number,
--           (SELECT SUM(debit)  FROM journal_lines WHERE journal_entry_id=je.id) AS dr,
--           (SELECT SUM(credit) FROM journal_lines WHERE journal_entry_id=je.id) AS cr
--    FROM journal_entries je
--    WHERE je.source='gl_entry_writer';
--    -- every row: dr = cr (cents-exact)
-- =========================================================================
