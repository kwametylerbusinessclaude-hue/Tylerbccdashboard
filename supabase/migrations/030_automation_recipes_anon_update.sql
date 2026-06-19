-- 030: enable anon role to UPDATE automation_recipes
--      so the Automations module's recipe enable/disable toggle works.
-- Pattern matches the existing anon_read_automation_recipes policy.
-- Single-tenant private dashboard; same shape as migrations 028 (memory) and 029 (compliance).
--
-- automation_recipes: UPDATE only (no INSERT/DELETE — recipes are seeded via
--   migrations / the recipe_seeds folder, not created from the UI).
-- automation_run_log: no change (read-only audit trail; runner writes via service role).
-- briefings, documents, settings: no change (read-only from this module).

DROP POLICY IF EXISTS anon_update_automation_recipes ON public.automation_recipes;
CREATE POLICY anon_update_automation_recipes
  ON public.automation_recipes
  FOR UPDATE
  TO anon
  USING (true)
  WITH CHECK (true);

-- Authenticated role policies for the day we move off the anon key.
DROP POLICY IF EXISTS authenticated_all_automation_recipes ON public.automation_recipes;
CREATE POLICY authenticated_all_automation_recipes
  ON public.automation_recipes
  FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS authenticated_all_automation_run_log ON public.automation_run_log;
CREATE POLICY authenticated_all_automation_run_log
  ON public.automation_run_log
  FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS authenticated_all_briefings ON public.briefings;
CREATE POLICY authenticated_all_briefings
  ON public.briefings
  FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);