\set ON_ERROR_STOP on

CREATE OR REPLACE FUNCTION pg_temp.assert_true(condition boolean, message text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF condition IS DISTINCT FROM true THEN RAISE EXCEPTION 'ASSERTION FAILED: %', message; END IF;
END
$$;

SELECT pg_temp.assert_true(
  (SELECT count(*) = 27 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r'),
  'exactly 27 V2 public tables');
SELECT pg_temp.assert_true(
  (SELECT count(*) = 27 AND bool_and(relrowsecurity) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r'),
  'RLS enabled on every V2 public table');
SELECT pg_temp.assert_true(
  NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = ANY(ARRAY['clients','customers','conversations','bookings','escalations','knowledge_base','weekly_reports'])),
  'unrelated V1 product tables absent');
SELECT pg_temp.assert_true(
  NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants WHERE table_schema = 'public' AND grantee = 'anon'),
  'anon has no public table grants');
SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND grantee IN ('authenticated','service_role')
      AND privilege_type IN ('TRUNCATE','REFERENCES','TRIGGER')
  ),
  'client/service table grants contain no infrastructure privileges');
SELECT pg_temp.assert_true((SELECT count(*) = 49 FROM pg_catalog.pg_policies WHERE schemaname = 'public'), 'exactly 49 security policies');
SELECT pg_temp.assert_true((SELECT count(*) = 49 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'), 'exactly 49 public functions');
SELECT pg_temp.assert_true((SELECT count(*) = 10 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'reachagent_private'), 'exactly 10 private functions');
SELECT pg_temp.assert_true((SELECT count(*) = 96 FROM pg_catalog.pg_indexes WHERE schemaname = 'public'), 'exactly 96 public indexes');
SELECT pg_temp.assert_true(
  (SELECT count(*) = 15 FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE NOT t.tgisinternal AND n.nspname IN ('public','auth')),
  'exactly 15 ReachAgent/Auth triggers');
SELECT pg_temp.assert_true(
  (SELECT r.rolname = 'reachagent_function_owner' AND NOT r.rolcanlogin AND r.rolbypassrls
   FROM pg_catalog.pg_namespace n JOIN pg_catalog.pg_roles r ON r.oid = n.nspowner
   WHERE n.nspname = 'reachagent_private'),
  'private schema owned by the dedicated NOLOGIN BYPASSRLS role');
SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members m
    JOIN pg_catalog.pg_roles r ON r.oid = m.roleid
    WHERE r.rolname = 'reachagent_function_owner'
      AND (m.inherit_option OR m.set_option)
  ),
  'no login can inherit or set the function-owner role');
SELECT pg_temp.assert_true(
  NOT has_schema_privilege('reachagent_function_owner', 'public', 'CREATE'),
  'function-owner role has no retained CREATE on public');
SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_default_acl d,
      LATERAL pg_catalog.aclexplode(COALESCE(d.defaclacl,pg_catalog.acldefault(d.defaclobjtype,d.defaclrole))) a
    WHERE d.defaclnamespace = (SELECT oid FROM pg_catalog.pg_namespace WHERE nspname = 'public')
      AND pg_catalog.pg_get_userbyid(d.defaclrole) IN ('postgres','reachagent_function_owner')
      AND pg_catalog.pg_get_userbyid(a.grantee) IN ('anon','authenticated','service_role')
  ),
  'no broad future app-owned public-object grants to client/service roles');
SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_namespace n,
      LATERAL pg_catalog.aclexplode(COALESCE(n.nspacl,pg_catalog.acldefault('n',n.nspowner))) a
    WHERE n.nspname = 'reachagent_private' AND a.grantee = 0 AND a.privilege_type = 'USAGE'
  )
  AND NOT has_schema_privilege('authenticated', 'reachagent_private', 'USAGE')
  AND NOT has_schema_privilege('service_role', 'reachagent_private', 'USAGE'),
  'private schema is unavailable to client/service roles');
SELECT pg_temp.assert_true(
  (SELECT r.rolname <> 'reachagent_function_owner'
   FROM pg_catalog.pg_namespace n JOIN pg_catalog.pg_roles r ON r.oid = n.nspowner
   WHERE n.nspname = 'extensions'),
  'platform extensions schema is not owned by the application function role');
SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE pg_catalog.pg_get_userbyid(p.proowner) = 'reachagent_function_owner'
      AND n.nspname IN ('public', 'reachagent_private')
      AND (
        pg_catalog.pg_get_functiondef(p.oid) LIKE '%auth.uid()%'
        OR pg_catalog.pg_get_functiondef(p.oid) LIKE '%auth.role()%'
      )
  ),
  'function-owner routines do not depend on managed auth schema privileges');
SELECT pg_temp.assert_true(
  (SELECT count(*) = 15 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prosecdef),
  'exactly 15 public SECURITY DEFINER functions');
SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prosecdef
      AND (
        pg_catalog.pg_get_userbyid(p.proowner) <> 'reachagent_function_owner'
        OR p.proconfig IS NULL
        OR NOT ('search_path=pg_catalog, public' = ANY(p.proconfig))
        OR has_function_privilege('anon', p.oid, 'EXECUTE')
        OR EXISTS (
          SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f',p.proowner))) a
          WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
        )
      )
  ),
  'all SECURITY DEFINER functions have safe owner, path, and execute ACL');
SELECT pg_temp.assert_true(to_regclass('public.workflow_runs') IS NOT NULL AND to_regclass('public.workflow_steps') IS NOT NULL, 'observability tables present');
SELECT pg_temp.assert_true((SELECT pg_get_constraintdef(oid) LIKE '%interested%' AND pg_get_constraintdef(oid) NOT LIKE '%closed_won%' FROM pg_catalog.pg_constraint WHERE conname = 'leads_status_check'), 'canonical status constraint present');
SELECT pg_temp.assert_true((SELECT pg_get_constraintdef(oid) ILIKE '%priority >= 1%priority <= 10%' FROM pg_catalog.pg_constraint WHERE conname = 'city_suburbs_priority_check'), 'priority constraint present');
SELECT pg_temp.assert_true(NOT EXISTS (
  SELECT 1 FROM public.leads
  WHERE email IS NOT NULL
    AND email NOT LIKE '%@example.test'
    AND id::text NOT LIKE '40000000-%'
), 'no non-synthetic lead email imported');
SELECT pg_temp.assert_true(NOT EXISTS (
  SELECT 1 FROM public.emails e
  WHERE e.body_text NOT ILIKE '%synthetic%'
    AND NOT EXISTS (SELECT 1 FROM public.leads l WHERE l.id = e.lead_id AND l.id::text LIKE '40000000-%')
), 'no non-synthetic email content imported');

CREATE OR REPLACE FUNCTION pg_temp.assert_public_tables_safe()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE item record; row_count bigint; expected_count bigint; seeded boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM public.settings
    WHERE key = 'v2_synthetic_seed_marker' AND value = 'SYNTHETIC_V2_ONLY'
  ) INTO seeded;

  IF (SELECT count(*) FROM public.profiles) NOT IN (0, 1) OR EXISTS (
    SELECT 1 FROM public.profiles
    WHERE email NOT LIKE '%@example.test' OR role <> 'admin' OR NOT is_active
  ) THEN
    RAISE EXCEPTION 'ASSERTION FAILED: profiles contains data other than the disposable V2 test admin';
  END IF;

  FOR item IN
    SELECT c.oid::regclass AS relation, c.relname
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> 'profiles'
  LOOP
    EXECUTE format('SELECT count(*) FROM %s', item.relation) INTO row_count;
    expected_count := CASE
      WHEN NOT seeded THEN 0
      WHEN item.relname = 'categories' THEN 2
      WHEN item.relname = 'category_email_templates' THEN 2
      WHEN item.relname = 'city_suburbs' THEN 3
      WHEN item.relname = 'emails' THEN 3
      WHEN item.relname = 'follow_ups' THEN 2
      WHEN item.relname = 'leads' THEN 5
      WHEN item.relname = 'settings' THEN 1
      ELSE 0
    END;
    IF row_count <> expected_count THEN
      RAISE EXCEPTION 'ASSERTION FAILED: hosted table % has % rows; expected %', item.relation, row_count, expected_count;
    END IF;
  END LOOP;

  IF seeded AND (
    EXISTS (
      SELECT 1 FROM public.leads
      WHERE id::text NOT LIKE '93000000-0000-0000-0000-%'
         OR email NOT LIKE '%@example.test'
         OR website NOT LIKE 'https://%.example.test'
         OR description <> 'SYNTHETIC_V2_TEST_DATA'
    )
    OR EXISTS (
      SELECT 1 FROM public.categories
      WHERE id::text NOT LIKE '91000000-0000-0000-0000-%' OR name NOT LIKE 'Synthetic %'
    )
    OR EXISTS (
      SELECT 1 FROM public.city_suburbs
      WHERE id::text NOT LIKE '92000000-0000-0000-0000-%'
    )
    OR EXISTS (
      SELECT 1 FROM public.emails
      WHERE id::text NOT LIKE '94000000-0000-0000-0000-%'
         OR body_text NOT ILIKE '%synthetic%'
    )
    OR EXISTS (
      SELECT 1 FROM public.follow_ups
      WHERE id::text NOT LIKE '95000000-0000-0000-0000-%'
    )
  ) THEN
    RAISE EXCEPTION 'ASSERTION FAILED: hosted fixture rows do not match the approved synthetic V2 markers';
  END IF;
END
$$;
SELECT pg_temp.assert_public_tables_safe();

SELECT 'VERIFY_HOSTED_V2_PASS' AS result,
  (SELECT count(*) FROM public.leads) AS lead_count,
  (SELECT count(*) FROM public.emails) AS email_count,
  (SELECT count(*) FROM pg_catalog.pg_policies WHERE schemaname = 'public') AS policy_count,
  (SELECT count(*) FROM pg_catalog.pg_indexes WHERE schemaname = 'public') AS index_count;
