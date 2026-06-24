-- 034_auth_must_change_password.sql
-- Adds the must_change_password flag and supporting per-user RLS policies
-- for the BCC login + forced-password-change flow.
-- Non-destructive: existing rows default to FALSE.
--
-- Built by Imaginary Farms LLC — The Claude Whisperer
-- imaginary-farms.com

-- 1) The flag itself
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;

-- 2) Ensure auth_user_id is unique so we can look up by it
CREATE UNIQUE INDEX IF NOT EXISTS users_auth_user_id_key
  ON public.users (auth_user_id)
  WHERE auth_user_id IS NOT NULL;

-- 3) Authenticated users can read their OWN public.users row
DROP POLICY IF EXISTS users_self_select ON public.users;
CREATE POLICY users_self_select ON public.users
  FOR SELECT
  TO authenticated
  USING (auth_user_id = auth.uid());

-- 4) Authenticated users can clear their OWN must_change_password flag
DROP POLICY IF EXISTS users_self_clear_mcp ON public.users;
CREATE POLICY users_self_clear_mcp ON public.users
  FOR UPDATE
  TO authenticated
  USING (auth_user_id = auth.uid())
  WITH CHECK (auth_user_id = auth.uid());

-- 5) Grants for authenticated role (anon already has them)
GRANT SELECT, UPDATE ON public.users TO authenticated;

COMMENT ON COLUMN public.users.must_change_password IS
  'When TRUE, the user MUST set a new password before reaching the dashboard. Set TRUE on admin-created accounts with a temporary password. Cleared automatically after a successful password change.';
