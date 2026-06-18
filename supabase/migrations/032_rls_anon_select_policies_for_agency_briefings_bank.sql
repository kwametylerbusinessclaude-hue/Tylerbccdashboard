-- Migration 032: Close RLS policy gap on agency, bank_transactions, briefings
-- Author: Claude (in-session, 2026-06-18 ~20:45 UTC)
-- DB version: matches schema_migrations '032_rls_anon_select_policies_for_agency_briefings_bank'
--
-- BACKGROUND:
--   2026-06-18 ~20:30 UTC, the live BCC web app at tylerbccdashboard.vercel.app
--   was rendering the MOCK_AGENCY fallback ("Smith Insurance Agency" /
--   "Jane Smith") in the header instead of "Tyler Insurance and Financial
--   Services LLC" / "Kwame Tyler".
--
-- ROOT CAUSE:
--   The agency table had RLS enabled but ZERO policies of any kind.  Anon
--   role had table-level GRANT SELECT (verified via has_table_privilege)
--   BUT PostgREST returned an empty array because there was no row-level
--   policy granting visibility.  BCCApp.jsx's agency .single() query then
--   silently failed (.single() requires exactly 1 row), and the React state
--   stayed on the hardcoded MOCK_AGENCY initial value.
--
--   Two other tables had the same gap: bank_transactions and briefings.
--   All other 27 application tables already had anon_read_* policies from
--   the migration 005 series — these three slipped through.
--
-- FIX:
--   Add PERMISSIVE SELECT policies for anon, matching the same unconditional
--   pattern used everywhere else (qual=true).  Agency scoping happens
--   client-side via VITE_AGENCY_ID; row-level filtering by agency_id is not
--   the security boundary here — the anon key already implies a public,
--   single-tenant deployment in BCC's current architecture.
--
-- VERIFIED POST-FIX:
--   - GET /rest/v1/agency?id=eq.<TYLER_UUID>&select=name,...     → 1 row, real data
--   - GET /rest/v1/bank_transactions?agency_id=eq.<TYLER_UUID>   → rows visible
--   - GET /rest/v1/briefings?agency_id=eq.<TYLER_UUID>           → rows visible

CREATE POLICY anon_read_agency ON public.agency
  FOR SELECT TO anon USING (true);

CREATE POLICY anon_read_bank_transactions ON public.bank_transactions
  FOR SELECT TO anon USING (true);

CREATE POLICY anon_read_briefings ON public.briefings
  FOR SELECT TO anon USING (true);
