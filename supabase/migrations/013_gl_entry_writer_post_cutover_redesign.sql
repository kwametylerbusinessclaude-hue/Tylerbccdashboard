-- =========================================================================
-- MIGRATION 013 — GL Entry Writer Post-Cutover Redesign
-- =========================================================================
-- Phase F established the canonical comp_recap line-item shape (10 recaps,
-- 540 rows, federal_ytd reconciled to $298,853.85 as of 2026-05-31). This
-- migration unblocks the GL Entry Writer recipe to actually POST those
-- recaps to journal_entries past the 2026-04-30 cutover.
--
-- WHAT THIS MIGRATION DOES (idempotent throughout):
--   1. Adds journal_entry_id FK column on comp_recap (audit linkage)
--   2. Adds 7 new line-of-business income accounts + 1 rename + 1 GFA
--      account + 1 non-cash income account + 1 S-Corp owner benefits expense
--      account to chart_of_accounts (=10 INSERTs, 1 UPDATE)
--   3. Creates comp_recap_account_mapping table — declarative routing rules
--      that determine which income account each comp_recap line credits
--   4. Seeds 21 mapping rules covering all post-cutover line-item shapes
--   5. Updates gl_default_sf_revenue_account_name setting from 'SF Commission
--      Income' (a header, can't take transactions) to 'Miscellaneous Income'
--      (a real fallback transaction account)
--   6. REWRITES gl_entry_writer() — replaces the placeholder implementation
--      from migration 012 with:
--        - 1 JE header per recap (not 1 per row); journal_lines for detail
--        - entry_date = recap_date (not period month-start)
--        - Cutover-aware (filters recap_date > gl_cutover_date)
--        - amount_type='half_month_activity' filter (avoids YTD double-count)
--        - Mapping-table-driven routing (no hardcoded comp_type -> account)
--        - Benefits wash: BENEFITS lines DR 6120 / CR 4180 (zero P&L impact)
--        - Populates comp_recap.journal_entry_id for round-trip auditability
--
-- DESIGN DOC: This redesign was conducted in a Claude session on 2026-06-10
-- through Q1-Q4 design questions. Mapping table lives in comp_recap_account_mapping
-- so future routing changes are pure SQL, no code deploy.
-- =========================================================================


-- =========================================================================
-- 1. Schema additions
-- =========================================================================

ALTER TABLE public.comp_recap
  ADD COLUMN IF NOT EXISTS journal_entry_id UUID REFERENCES public.journal_entries(id);

COMMENT ON COLUMN public.comp_recap.journal_entry_id IS
  'Set by gl_entry_writer when this row has been posted to a JE. NULL = unposted (or pre-cutover archive-only). Enables audit round-trip from comp_recap line to GL.';


-- =========================================================================
-- 2. Chart of accounts: line-of-business income accounts + benefits + GFA
-- =========================================================================
-- Insert any missing accounts. Existing ones (4040 Health, 6100 Employee
-- Benefits header, etc.) are left alone via ON CONFLICT DO NOTHING.

INSERT INTO public.chart_of_accounts
  (agency_id, account_code, account_name, account_type, account_subtype, is_active, is_system)
VALUES
  ('98aa8b9b-92e4-4ebc-8727-aa00ce696fab', '4011', 'Auto Commission - New',                  'income', 'commission', true, false),
  ('98aa8b9b-92e4-4ebc-8727-aa00ce696fab', '4012', 'Auto Commission - Renewal',              'income', 'commission', true, false),
  ('98aa8b9b-92e4-4ebc-8727-aa00ce696fab', '4013', 'Fire Commission - New',                  'income', 'commission', true, false),
  ('98aa8b9b-92e4-4ebc-8727-aa00ce696fab', '4014', 'Fire Commission - Renewal',              'income', 'commission', true, false),
  ('98aa8b9b-92e4-4ebc-8727-aa00ce696fab', '4015', 'Std Auto Commission - New',              'income', 'commission', true, false),
  ('98aa8b9b-92e4-4ebc-8727-aa00ce696fab', '4016', 'Std Auto Commission - Renewal',          'income', 'commission', true, false),
  ('98aa8b9b-92e4-4ebc-8727-aa00ce696fab', '4031', 'Life Insurance Commission - Renewal',    'income', 'commission', true, false),
  ('98aa8b9b-92e4-4ebc-8727-aa00ce696fab', '4170', 'GFA Bank Referral Income',               'income', 'referral',   true, false),
  ('98aa8b9b-92e4-4ebc-8727-aa00ce696fab', '4180', 'Non-Cash Reportable Benefits',           'income', 'non_cash',   true, false),
  ('98aa8b9b-92e4-4ebc-8727-aa00ce696fab', '6120', 'S-Corp Owner Health & Welfare',          'expense', 'benefits',  true, false)
ON CONFLICT DO NOTHING;

-- Rename existing 4030 to clarify it's the New side (4031 covers Renewal)
UPDATE public.chart_of_accounts
SET account_name = 'Life Insurance Commission - New'
WHERE agency_id='98aa8b9b-92e4-4ebc-8727-aa00ce696fab'
  AND account_code='4030'
  AND account_name = 'Life Insurance Commission';


-- =========================================================================
-- 3. Mapping table: comp_recap row -> income account
-- =========================================================================

CREATE TABLE IF NOT EXISTS public.comp_recap_account_mapping (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id uuid NOT NULL,
  comp_type text NOT NULL,
  comp_category text,
  description_pattern text,
  credit_account_code text NOT NULL,
  debit_account_code text,
  is_benefit_wash boolean NOT NULL DEFAULT false,
  priority integer NOT NULL DEFAULT 100,
  is_active boolean NOT NULL DEFAULT true,
  notes text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ix_comp_recap_mapping_unique
ON public.comp_recap_account_mapping (
  agency_id, comp_type, COALESCE(comp_category, ''), COALESCE(description_pattern, '')
) WHERE is_active = true;

CREATE INDEX IF NOT EXISTS ix_comp_recap_mapping_lookup
ON public.comp_recap_account_mapping (agency_id, comp_type, is_active, priority);


-- =========================================================================
-- 4. Seed the 21 mapping rules
-- =========================================================================

INSERT INTO public.comp_recap_account_mapping
  (agency_id, comp_type, comp_category, description_pattern, credit_account_code, debit_account_code, is_benefit_wash, priority, notes)
VALUES
  -- MUTL: split AUTO vs HEALTH by description pattern (priority 10)
  ('98aa8b9b-92e4-4ebc-8727-aa00ce696fab', 'MUTL', 'new_business',    'AUTO%',   '4011', NULL, false, 10, 'AUTO NEW BUSINESS'),
  ('98aa8b9b-92e4-4ebc-8727-aa00ce696fab', 'MUTL', 'new_amd66',       'AUTO%',   '4011', NULL, false, 10, 'AUTO NEW - AMD66'),
  ('98aa8b9b-92e4-4ebc-8727-aa00ce696fab', 'MUTL', 'renewal_service', 'AUTO%',   '4012', NULL, false, 10, 'AUTO RENEWAL SERVICE'),
  ('98aa8b9b-92e4-4ebc-8727-aa00ce696fab', 'MUTL', 'renewal_amd66',   'AUTO%',   '4012', NULL, false, 10, 'AUTO RENEWAL - AMD66'),
  ('98aa8b9b-92e4-4ebc-8727-aa00ce696fab', 'MUTL', 'new_business',    'HEALTH%', '4040', NULL, false, 10, 'HEALTH NEW BUSINESS'),
  ('98aa8b9b-92e4-4ebc-8727-aa00ce696fab', 'MUTL', 'renewal_service', 'HEALTH%', '4040', NULL, false, 10, 'HEALTH RENEWAL SERVICE'),
  -- SFL
  ('98aa8b9b-92e4-4ebc-8727-aa00ce696fab', 'SFL', 'first_year_writing', NULL, '4030', NULL, false, 50, 'FIRST YEAR WRITING'),
  ('98aa8b9b-92e4-4ebc-8727-aa00ce696fab', 'SFL', 'renewal_writing',    NULL, '4031', NULL, false, 50, 'RENEWAL WRITING'),
  ('98aa8b9b-92e4-4ebc-8727-aa00ce696fab', 'SFL', 'servicing',          NULL, '4031', NULL, false, 50, 'SERVICING (lump with renewal)'),
  -- FIRE
  ('98aa8b9b-92e4-4ebc-8727-aa00ce696fab', 'FIRE', 'new_business',    NULL, '4013', NULL, false, 50, 'FIRE NEW BUSINESS'),
  ('98aa8b9b-92e4-4ebc-8727-aa00ce696fab', 'FIRE', 'new_amd66',       NULL, '4013', NULL, false, 50, 'FIRE NEW - AMD66'),
  ('98aa8b9b-92e4-4ebc-8727-aa00ce696fab', 'FIRE', 'renewal_service', NULL, '4014', NULL, false, 50, 'FIRE RENEWAL SERVICE'),
  ('98aa8b9b-92e4-4ebc-8727-aa00ce696fab', 'FIRE', 'renewal_amd66',   NULL, '4014', NULL, false, 50, 'FIRE RENEWAL - AMD66'),
  -- STDAUTO
  ('98aa8b9b-92e4-4ebc-8727-aa00ce696fab', 'STDAUTO', 'new_business',    NULL, '4015', NULL, false, 50, 'STD AUTO NEW BUSINESS'),
  ('98aa8b9b-92e4-4ebc-8727-aa00ce696fab', 'STDAUTO', 'new_amd66',       NULL, '4015', NULL, false, 50, 'STD AUTO NEW - AMD66'),
  ('98aa8b9b-92e4-4ebc-8727-aa00ce696fab', 'STDAUTO', 'renewal_service', NULL, '4016', NULL, false, 50, 'STD AUTO RENEWAL SERVICE'),
  ('98aa8b9b-92e4-4ebc-8727-aa00ce696fab', 'STDAUTO', 'renewal_amd66',   NULL, '4016', NULL, false, 50, 'STD AUTO RENEWAL - AMD66'),
  -- AIPP
  ('98aa8b9b-92e4-4ebc-8727-aa00ce696fab', 'AIPP', NULL, NULL, '4110', NULL, false, 100, 'All AIPP categories -> 4110'),
  -- BONUS
  ('98aa8b9b-92e4-4ebc-8727-aa00ce696fab', 'BONUS', NULL, NULL, '4120', NULL, false, 100, 'ScoreBoard + Cash Award - Life -> 4120'),
  -- GFA
  ('98aa8b9b-92e4-4ebc-8727-aa00ce696fab', 'GFA', NULL, NULL, '4170', NULL, false, 100, 'US Bank New Deposit'),
  -- BENEFITS wash
  ('98aa8b9b-92e4-4ebc-8727-aa00ce696fab', 'BENEFITS', NULL, NULL, '4180', '6120', true, 100, 'S-Corp owner medical/dental/group term life wash: DR 6120 / CR 4180')
ON CONFLICT DO NOTHING;


-- =========================================================================
-- 5. Fix the default revenue fallback setting
-- =========================================================================

UPDATE public.settings
SET setting_value = 'Miscellaneous Income',
    updated_at = NOW(),
    updated_by = 'migration_013'
WHERE agency_id='98aa8b9b-92e4-4ebc-8727-aa00ce696fab'
  AND setting_key='gl_default_sf_revenue_account_name';


-- =========================================================================
-- 6. Replace gl_entry_writer() — full rewrite from migration 012
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

      INSERT INTO public.journal_lines (
        journal_entry_id, agency_id, account_id, debit, credit, description, created_at
      ) VALUES
        (v_entry_id, p_agency_id, v_debit_acct_id,  v_line.amount, 0, v_line.description, v_now),
        (v_entry_id, p_agency_id, v_credit_acct_id, 0, v_line.amount, v_line.description, v_now);

      v_lines_inserted := v_lines_inserted + 2;
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
               CASE WHEN v_total_wash > 0
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
-- Idempotent. Safe to re-run.
-- =========================================================================
