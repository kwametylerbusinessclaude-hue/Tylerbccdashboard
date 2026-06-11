-- =========================================================================
-- RECIPE SEED 14 — GL Account Mapping (per-agency template)
-- =========================================================================
-- COMPANION TO migration 013_gl_entry_writer_post_cutover_redesign.sql.
-- Migration 013 created the SCHEMA (comp_recap_account_mapping table,
-- the new income/expense accounts, the rewritten gl_entry_writer function).
-- This seed file applies AGENCY-SPECIFIC DATA into those structures.
--
-- USAGE for a new BCC install:
--   1. Replace every occurrence of {{agency_id}} with the new agency's UUID
--      (the UUID from the agency table — same value used in recipe_seeds/01-13).
--   2. Review the chart_of_accounts INSERTs — adjust account_code numbering
--      if the new agency's chart of accounts uses a different numbering scheme.
--   3. Review the comp_recap_account_mapping rules — they default to the SF
--      product-family canonical names (MUTL/SFL/FIRE/STDAUTO/AIPP/BONUS/GFA/
--      BENEFITS). If the new agency uses different comp_type strings from
--      their comp recap parser, update the comp_type column accordingly.
--   4. Apply via `psql` or Supabase SQL editor.
--   5. Verify with the smoke test at the bottom of this file.
--
-- IDEMPOTENT throughout — safe to re-run.
-- =========================================================================


-- =========================================================================
-- 1. Add the line-of-business income + benefits accounts to chart_of_accounts
-- =========================================================================
-- These accounts give gl_entry_writer somewhere to credit per-line-of-business
-- commission revenue. If the new agency uses a different code numbering, adjust
-- account_code values (and the credit_account_code values in section 3 to match).

INSERT INTO public.chart_of_accounts
  (agency_id, account_code, account_name, account_type, account_subtype, is_active, is_system)
VALUES
  ('{{agency_id}}', '4011', 'Auto Commission - New',                  'income',  'commission', true, false),
  ('{{agency_id}}', '4012', 'Auto Commission - Renewal',              'income',  'commission', true, false),
  ('{{agency_id}}', '4013', 'Fire Commission - New',                  'income',  'commission', true, false),
  ('{{agency_id}}', '4014', 'Fire Commission - Renewal',              'income',  'commission', true, false),
  ('{{agency_id}}', '4015', 'Std Auto Commission - New',              'income',  'commission', true, false),
  ('{{agency_id}}', '4016', 'Std Auto Commission - Renewal',          'income',  'commission', true, false),
  ('{{agency_id}}', '4031', 'Life Insurance Commission - Renewal',    'income',  'commission', true, false),
  ('{{agency_id}}', '4170', 'GFA Bank Referral Income',               'income',  'referral',   true, false),
  ('{{agency_id}}', '4180', 'Non-Cash Reportable Benefits',           'income',  'non_cash',   true, false),
  ('{{agency_id}}', '6120', 'S-Corp Owner Health & Welfare',          'expense', 'benefits',   true, false)
ON CONFLICT DO NOTHING;

-- Rename the legacy 4030 to make the New / Renewal split explicit.
-- Only triggers if the account still has the original generic name.
UPDATE public.chart_of_accounts
SET account_name = 'Life Insurance Commission - New'
WHERE agency_id='{{agency_id}}'
  AND account_code='4030'
  AND account_name = 'Life Insurance Commission';


-- =========================================================================
-- 2. Point the GL fallback at a real transaction account
-- =========================================================================
-- The default chart_of_accounts seed (003) sets gl_default_sf_revenue_account_name
-- to "SF Commission Income" — a header (4000) that can't take transactions.
-- Point it at "Miscellaneous Income" so unmapped lines land somewhere safe.

UPDATE public.settings
SET setting_value = 'Miscellaneous Income',
    updated_at = NOW(),
    updated_by = 'recipe_seed_14'
WHERE agency_id='{{agency_id}}'
  AND setting_key='gl_default_sf_revenue_account_name';


-- =========================================================================
-- 3. Seed the comp_recap -> income account mapping (21 rules)
-- =========================================================================
-- Match priority: lower number wins. With ties, ORDER BY in gl_entry_writer
-- gives non-null description_pattern -> then non-null comp_category -> catch-all.
-- BENEFITS lines are routed to a P&L wash (DR 6120 / CR 4180, zero net).

INSERT INTO public.comp_recap_account_mapping
  (agency_id, comp_type, comp_category, description_pattern, credit_account_code, debit_account_code, is_benefit_wash, priority, notes)
VALUES
  -- MUTL: split AUTO vs HEALTH by description pattern (most specific = priority 10)
  ('{{agency_id}}', 'MUTL', 'new_business',    'AUTO%',   '4011', NULL, false, 10, 'AUTO NEW BUSINESS'),
  ('{{agency_id}}', 'MUTL', 'new_amd66',       'AUTO%',   '4011', NULL, false, 10, 'AUTO NEW - AMD66'),
  ('{{agency_id}}', 'MUTL', 'renewal_service', 'AUTO%',   '4012', NULL, false, 10, 'AUTO RENEWAL SERVICE'),
  ('{{agency_id}}', 'MUTL', 'renewal_amd66',   'AUTO%',   '4012', NULL, false, 10, 'AUTO RENEWAL - AMD66'),
  ('{{agency_id}}', 'MUTL', 'new_business',    'HEALTH%', '4040', NULL, false, 10, 'HEALTH NEW BUSINESS'),
  ('{{agency_id}}', 'MUTL', 'renewal_service', 'HEALTH%', '4040', NULL, false, 10, 'HEALTH RENEWAL SERVICE'),

  -- SFL (Life): by comp_category
  ('{{agency_id}}', 'SFL', 'first_year_writing', NULL, '4030', NULL, false, 50, 'FIRST YEAR WRITING'),
  ('{{agency_id}}', 'SFL', 'renewal_writing',    NULL, '4031', NULL, false, 50, 'RENEWAL WRITING'),
  ('{{agency_id}}', 'SFL', 'servicing',          NULL, '4031', NULL, false, 50, 'SERVICING (lump with renewal)'),

  -- FIRE: by comp_category
  ('{{agency_id}}', 'FIRE', 'new_business',    NULL, '4013', NULL, false, 50, 'FIRE NEW BUSINESS'),
  ('{{agency_id}}', 'FIRE', 'new_amd66',       NULL, '4013', NULL, false, 50, 'FIRE NEW - AMD66'),
  ('{{agency_id}}', 'FIRE', 'renewal_service', NULL, '4014', NULL, false, 50, 'FIRE RENEWAL SERVICE'),
  ('{{agency_id}}', 'FIRE', 'renewal_amd66',   NULL, '4014', NULL, false, 50, 'FIRE RENEWAL - AMD66'),

  -- STDAUTO: by comp_category
  ('{{agency_id}}', 'STDAUTO', 'new_business',    NULL, '4015', NULL, false, 50, 'STD AUTO NEW BUSINESS'),
  ('{{agency_id}}', 'STDAUTO', 'new_amd66',       NULL, '4015', NULL, false, 50, 'STD AUTO NEW - AMD66'),
  ('{{agency_id}}', 'STDAUTO', 'renewal_service', NULL, '4016', NULL, false, 50, 'STD AUTO RENEWAL SERVICE'),
  ('{{agency_id}}', 'STDAUTO', 'renewal_amd66',   NULL, '4016', NULL, false, 50, 'STD AUTO RENEWAL - AMD66'),

  -- AIPP (program earnings, paid each January): single bucket
  ('{{agency_id}}', 'AIPP', NULL, NULL, '4110', NULL, false, 100, 'All AIPP categories -> 4110'),

  -- BONUS: ScoreBoard + Cash Award - Life all to 4120
  ('{{agency_id}}', 'BONUS', NULL, NULL, '4120', NULL, false, 100, 'ScoreBoard + Cash Award - Life -> 4120'),

  -- GFA: US Bank New Deposit -> 4170
  ('{{agency_id}}', 'GFA', NULL, NULL, '4170', NULL, false, 100, 'US Bank New Deposit'),

  -- BENEFITS: P&L wash (DR 6120 / CR 4180) — §1372 S-Corp owner non-cash benefits
  ('{{agency_id}}', 'BENEFITS', NULL, NULL, '4180', '6120', true, 100, 'S-Corp owner medical/dental/group term life wash: DR 6120 / CR 4180')
ON CONFLICT DO NOTHING;


-- =========================================================================
-- 4. Smoke test — verify the seed worked
-- =========================================================================
-- Run these manually after applying; both should return what you expect.

-- Expect 21 active rules for this agency:
-- SELECT comp_type, COUNT(*) FROM comp_recap_account_mapping
-- WHERE agency_id='{{agency_id}}' AND is_active=true GROUP BY comp_type ORDER BY comp_type;

-- Expect every credit_account_code in the mapping table to exist in chart_of_accounts:
-- SELECT m.credit_account_code, c.account_name
-- FROM comp_recap_account_mapping m
-- LEFT JOIN chart_of_accounts c ON c.agency_id=m.agency_id AND c.account_code=m.credit_account_code
-- WHERE m.agency_id='{{agency_id}}' AND m.is_active=true
-- ORDER BY m.priority, m.comp_type;
-- Any NULL account_name = missing chart account, must be created before first cron run.

-- Expect the settings update landed:
-- SELECT setting_key, setting_value FROM settings
-- WHERE agency_id='{{agency_id}}' AND setting_key='gl_default_sf_revenue_account_name';
-- Should return 'Miscellaneous Income'.
