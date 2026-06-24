-- 035_extend_anon_policies_to_authenticated.sql
-- After 034 introduced Supabase Auth, the existing app started hitting the database
-- as role `authenticated` instead of `anon`. Every existing RLS policy in public was
-- scoped to `anon` only, so authenticated requests saw zero rows everywhere.
--
-- This migration extends each anon-only policy to also cover `authenticated`,
-- preserving the original USING / WITH CHECK clauses untouched.
-- Policies that were already `auth_only` (introduced in 034 for per-user safety)
-- are left alone.
--
-- Built by Imaginary Farms LLC — The Claude Whisperer

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT schemaname, tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND roles = ARRAY['anon']::name[]
  LOOP
    EXECUTE format(
      'ALTER POLICY %I ON %I.%I TO anon, authenticated',
      r.policyname, r.schemaname, r.tablename
    );
  END LOOP;
END
$$;
