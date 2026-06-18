-- 029_compliance_tables_anon_write_policies.sql
-- Date: 2026-06-18
-- Why:  ComplianceCenter.jsx (rewritten in commit 8b8530f5) now writes to
--       compliance_rules via "Add Custom Rule" and to compliance_log via
--       "Log Activity". These tables had only anon SELECT policies, so writes
--       under RLS would silently fail. Mirrors migration 028's pattern.
--
-- compliance_rules: INSERT only (append-only library; deactivate via is_active=false)
-- compliance_log:   INSERT only (audit log is immutable by design)
-- compliance_calendar: unchanged (no UI writes from this module)
--
-- Idempotent.

DROP POLICY IF EXISTS anon_insert_compliance_rules ON public.compliance_rules;
CREATE POLICY anon_insert_compliance_rules
  ON public.compliance_rules
  FOR INSERT
  TO anon
  WITH CHECK (true);

DROP POLICY IF EXISTS anon_insert_compliance_log ON public.compliance_log;
CREATE POLICY anon_insert_compliance_log
  ON public.compliance_log
  FOR INSERT
  TO anon
  WITH CHECK (true);

DROP POLICY IF EXISTS authenticated_all_compliance_rules ON public.compliance_rules;
CREATE POLICY authenticated_all_compliance_rules
  ON public.compliance_rules
  FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS authenticated_all_compliance_log ON public.compliance_log;
CREATE POLICY authenticated_all_compliance_log
  ON public.compliance_log
  FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);
