-- Catalog-level checks for profile read privacy. Separate JWT integration tests
-- are still required for member/nonmember behavior across two accounts.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'profiles'
      AND policyname = 'Profiles are viewable by any signed-in user'
  ) THEN
    RAISE EXCEPTION 'broad authenticated profiles SELECT policy must be removed';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'profiles'
      AND policyname = 'Users can view own and related profiles'
      AND cmd = 'SELECT'
  ) THEN
    RAISE EXCEPTION 'relationship-scoped profiles SELECT policy is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'profiles'
      AND policyname = 'Users can view own and related profiles'
      AND position('status_views' in qual) > 0
      AND position('status_replies' in qual) > 0
  ) THEN
    RAISE EXCEPTION 'status viewers and private reply senders must retain profile labels';
  END IF;

  IF has_table_privilege('authenticated', 'public.profiles', 'SELECT') THEN
    RAISE EXCEPTION 'authenticated must not have table-wide profiles SELECT';
  END IF;
  IF has_column_privilege('authenticated', 'public.profiles', 'avatar_url', 'SELECT')
     OR has_column_privilege('authenticated', 'public.profiles', 'status', 'SELECT')
     OR has_column_privilege('authenticated', 'public.profiles', 'online', 'SELECT')
     OR has_column_privilege('authenticated', 'public.profiles', 'created_at', 'SELECT') THEN
    RAISE EXCEPTION 'private profile columns must not be directly selectable';
  END IF;
  IF NOT has_column_privilege('authenticated', 'public.profiles', 'id', 'SELECT')
     OR NOT has_column_privilege('authenticated', 'public.profiles', 'name', 'SELECT')
     OR NOT has_column_privilege('authenticated', 'public.profiles', 'username', 'SELECT')
     OR NOT has_column_privilege('authenticated', 'public.profiles', 'avatar_color', 'SELECT') THEN
    RAISE EXCEPTION 'minimal public identity projection grants are incomplete';
  END IF;

  IF NOT has_function_privilege('authenticated', 'public.get_my_profile()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.get_my_profile()', 'EXECUTE') THEN
    RAISE EXCEPTION 'get_my_profile execution grants are incorrect';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.get_conversation_profile_directory(uuid[])', 'EXECUTE')
     OR has_function_privilege('anon', 'public.get_conversation_profile_directory(uuid[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'conversation profile projection execution grants are incorrect';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.search_people(text,integer)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.search_people(text,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'search_people execution grants are incorrect';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'people_search_limits'
      AND c.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'people_search_limits must have RLS enabled';
  END IF;
  IF has_table_privilege('authenticated', 'public.people_search_limits', 'SELECT')
     OR has_table_privilege('authenticated', 'public.people_search_limits', 'INSERT')
     OR has_table_privilege('authenticated', 'public.people_search_limits', 'UPDATE') THEN
    RAISE EXCEPTION 'authenticated must not access internal people search quotas';
  END IF;
END;
$$;

-- Manual two-account integration checks:
-- 1. A user can read their own full profile only via get_my_profile().
-- 2. A conversation member can resolve the other participant via the scoped RPC.
-- 3. A nonmember cannot resolve an arbitrary profile ID or directly read private columns.
-- 4. A user cannot discover a profile with visibility=nobody or either-direction block.
