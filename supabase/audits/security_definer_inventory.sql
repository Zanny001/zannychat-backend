-- READ-ONLY staging audit: inventory SECURITY DEFINER routines and triage
-- high-risk configurations. Run with a database administrator role in Supabase.
-- This query does not alter schema, privileges, or application data.
WITH definer_inventory AS (
  SELECT n.nspname AS schema_name,
         p.proname AS function_name,
         pg_get_function_identity_arguments(p.oid) AS identity_arguments,
         pg_get_userbyid(p.proowner) AS owner_name,
         p.proconfig AS function_settings,
         NOT EXISTS (
           SELECT 1
           FROM unnest(COALESCE(p.proconfig, ARRAY[]::text[])) AS cfg(setting)
           WHERE cfg.setting LIKE 'search_path=%'
         ) AS search_path_not_pinned,
         EXISTS (
           SELECT 1
           FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS acl
           WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
         ) AS public_can_execute,
         has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_can_execute,
         has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_can_execute,
         has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role_can_execute,
         p.proacl AS explicit_acl
  FROM pg_catalog.pg_proc AS p
  JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
  WHERE p.prosecdef
    AND n.nspname NOT IN ('pg_catalog', 'information_schema')
)
SELECT schema_name,
       function_name,
       identity_arguments,
       owner_name,
       function_settings,
       search_path_not_pinned,
       public_can_execute,
       anon_can_execute,
       authenticated_can_execute,
       service_role_can_execute,
       explicit_acl,
       CASE
         WHEN search_path_not_pinned AND public_can_execute
           THEN 'CRITICAL REVIEW: unpinned search_path and PUBLIC EXECUTE'
         WHEN search_path_not_pinned AND anon_can_execute
           THEN 'HIGH REVIEW: unpinned search_path and anon execution'
         WHEN search_path_not_pinned
           THEN 'HIGH REVIEW: search_path is not pinned'
         WHEN public_can_execute
           THEN 'REVIEW: PUBLIC EXECUTE grant'
         WHEN anon_can_execute
           THEN 'REVIEW: anon can execute'
         ELSE 'REVIEW FUNCTION BODY, AUTHORIZATION, AND INTENDED CALLERS'
       END AS triage
FROM definer_inventory
ORDER BY search_path_not_pinned DESC,
         public_can_execute DESC,
         anon_can_execute DESC,
         schema_name,
         function_name,
         identity_arguments;
