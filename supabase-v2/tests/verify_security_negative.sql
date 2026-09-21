\set ON_ERROR_STOP on

CREATE OR REPLACE FUNCTION pg_temp.expect_denied(
  test_name text,
  test_role text,
  jwt_role text,
  jwt_sub text,
  statement_sql text
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claim.role',jwt_role,true);
  PERFORM set_config('request.jwt.claim.sub',COALESCE(jwt_sub,''),true);
  EXECUTE format('SET LOCAL ROLE %I',test_role);
  BEGIN
    EXECUTE statement_sql;
    RAISE EXCEPTION 'EXPECTED DENIAL DID NOT OCCUR: %',test_name;
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  RESET ROLE;
END
$$;

SELECT pg_temp.expect_denied('anon read leads','anon','anon',NULL,'SELECT * FROM public.leads');
SELECT pg_temp.expect_denied('anon mutate leads','anon','anon',NULL,$sql$INSERT INTO public.leads(business_name,category_name,city) VALUES ('anon','none','Sydney')$sql$);
SELECT pg_temp.expect_denied('anon read settings','anon','anon',NULL,'SELECT * FROM public.settings');
SELECT pg_temp.expect_denied('anon operational RPC','anon','anon',NULL,'SELECT public.get_lead_status_counts()');
SELECT pg_temp.expect_denied('anon SECURITY DEFINER','anon','anon',NULL,'SELECT public.is_active_admin()');
SELECT pg_temp.expect_denied('anon workflow read','anon','anon',NULL,'SELECT * FROM public.workflow_runs');
SELECT pg_temp.expect_denied('anon workflow RPC','anon','anon',NULL,'SELECT public.admin_workflow_runs()');

SELECT pg_temp.expect_denied(
  'member admin-only RPC','authenticated','authenticated',
  '10000000-0000-0000-0000-000000000001',
  'SELECT public.get_data_quality_summary()');
SELECT pg_temp.expect_denied(
  'member privileged profile update','authenticated','authenticated',
  '10000000-0000-0000-0000-000000000001',
  $sql$UPDATE public.profiles SET role='admin' WHERE id='10000000-0000-0000-0000-000000000001'$sql$);
SELECT pg_temp.expect_denied(
  'member infrastructure read','authenticated','authenticated',
  '10000000-0000-0000-0000-000000000001',
  'SELECT * FROM public.distributed_locks');
SELECT pg_temp.expect_denied(
  'member config mutation','authenticated','authenticated',
  '10000000-0000-0000-0000-000000000001',
  $sql$INSERT INTO public.categories(workspace_id,name) VALUES ('00000000-0000-0000-0000-000000000001','Member Must Not Manage Config')$sql$);
SELECT pg_temp.expect_denied(
  'member workflow mutation','authenticated','authenticated',
  '10000000-0000-0000-0000-000000000001',
  $sql$INSERT INTO public.workflow_runs(workflow_type,source) VALUES ('denied','security_test')$sql$);
DO $$
BEGIN
  IF has_function_privilege('authenticated','public.claim_recipient_outreach(uuid,uuid,text)','EXECUTE') THEN
    RAISE EXCEPTION 'authenticated unexpectedly has EXECUTE on service-only claim RPC';
  END IF;
END
$$;

SELECT 'VERIFY_SECURITY_NEGATIVE_PASS' AS result;
