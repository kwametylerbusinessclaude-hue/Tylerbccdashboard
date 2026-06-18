-- 028_persistent_memory_anon_write_policies.sql
-- Date: 2026-06-18
-- Why:  The Memory module (src/modules/PersistentMemory.jsx) was wired to the
--       live persistent_memory table in commit 4fe2a2ae. The table already had
--       an anon SELECT policy (anon_read_persistent_memory) but no INSERT or
--       UPDATE policies, so the Add / Edit / soft-Delete buttons in the web app
--       would silently fail under RLS. Adds matching write policies in the same
--       USING (true) shape as the existing read policy and the anon_read_* policies
--       on every other table in the schema (single-tenant private dashboard).
--
-- Soft delete pattern: UPDATE is_active=false. We intentionally do not add a
-- DELETE policy; hard deletes should not flow through the web app.
--
-- Idempotent.

DROP POLICY IF EXISTS anon_insert_persistent_memory ON public.persistent_memory;
CREATE POLICY anon_insert_persistent_memory
  ON public.persistent_memory
  FOR INSERT
  TO anon
  WITH CHECK (true);

DROP POLICY IF EXISTS anon_update_persistent_memory ON public.persistent_memory;
CREATE POLICY anon_update_persistent_memory
  ON public.persistent_memory
  FOR UPDATE
  TO anon
  USING (true)
  WITH CHECK (true);

-- Authenticated role policy for the day we move the web app off the anon key.
DROP POLICY IF EXISTS authenticated_all_persistent_memory ON public.persistent_memory;
CREATE POLICY authenticated_all_persistent_memory
  ON public.persistent_memory
  FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);
