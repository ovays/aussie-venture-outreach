\set ON_ERROR_STOP on

CREATE OR REPLACE FUNCTION pg_temp.assert_true(condition boolean, message text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF condition IS DISTINCT FROM true THEN RAISE EXCEPTION 'ASSERTION FAILED: %',message; END IF;
END
$$;

-- Catalog inventory and exclusions.
SELECT pg_temp.assert_true(
  (SELECT count(*)=30 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'),
  'exactly 30 public ReachAgent tables after the tenancy migration');
SELECT pg_temp.assert_true(
  NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY(ARRAY['clients','customers','conversations','bookings','escalations','knowledge_base','weekly_reports','v_conversation_thread','v_bookings_full','v_daily_summary'])),
  'unrelated WhatsApp/bookings objects are absent');
SELECT pg_temp.assert_true(
  (SELECT count(*)=0 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('v','m','S')),
  'no public views/materialized views/sequences');
SELECT pg_temp.assert_true(
  (SELECT extnamespace=(SELECT oid FROM pg_catalog.pg_namespace WHERE nspname='extensions') FROM pg_catalog.pg_extension WHERE extname='pg_trgm'),
  'pg_trgm is installed in extensions');
SELECT pg_temp.assert_true(
  (SELECT r.rolname='reachagent_function_owner' AND NOT r.rolcanlogin AND r.rolbypassrls
   FROM pg_catalog.pg_namespace n JOIN pg_catalog.pg_roles r ON r.oid=n.nspowner
   WHERE n.nspname='reachagent_private'),
  'private schema has the dedicated NOLOGIN BYPASSRLS owner');
SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members m
    JOIN pg_catalog.pg_roles r ON r.oid=m.roleid
    WHERE r.rolname='reachagent_function_owner'
      AND (m.inherit_option OR m.set_option)
  ),
  'no login can inherit or set the function-owner role');
SELECT pg_temp.assert_true(
  NOT has_schema_privilege('reachagent_function_owner','public','CREATE'),
  'function-owner role has no retained CREATE on public');
SELECT pg_temp.assert_true(
  (SELECT r.rolname<>'reachagent_function_owner'
   FROM pg_catalog.pg_namespace n JOIN pg_catalog.pg_roles r ON r.oid=n.nspowner
   WHERE n.nspname='extensions'),
  'extensions remains platform-owned');
SELECT pg_temp.assert_true(
  NOT EXISTS (SELECT 1 FROM pg_catalog.pg_extension WHERE extname IN ('pgcrypto','uuid-ossp')),
  'unused pgcrypto and uuid-ossp are absent');

-- Constraints and nullability.
SELECT pg_temp.assert_true(
  (SELECT is_nullable='NO' AND column_default='1' FROM information_schema.columns WHERE table_schema='public' AND table_name='city_suburbs' AND column_name='priority'),
  'city_suburbs.priority is NOT NULL DEFAULT 1');
SELECT pg_temp.assert_true(
  (SELECT pg_get_constraintdef(oid) ILIKE '%priority >= 1%priority <= 10%' FROM pg_catalog.pg_constraint WHERE conname='city_suburbs_priority_check'),
  'city_suburbs priority check is 1..10');
SELECT pg_temp.assert_true(
  (SELECT is_nullable='YES' FROM information_schema.columns WHERE table_schema='public' AND table_name='leads' AND column_name='category_id'),
  'leads.category_id remains nullable for staged remediation');
SELECT pg_temp.assert_true(
  (SELECT pg_get_constraintdef(oid) LIKE '%interested%' AND pg_get_constraintdef(oid) NOT LIKE '%closed_won%' AND pg_get_constraintdef(oid) NOT LIKE '%dm_queued%' FROM pg_catalog.pg_constraint WHERE conname='leads_status_check'),
  'canonical lead status check');

-- RLS, policies, grants and definer inventory.
SELECT pg_temp.assert_true(
  (SELECT count(*)=30 AND bool_and(relrowsecurity) AND NOT bool_or(relforcerowsecurity)
   FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='public' AND c.relkind='r'),
  'RLS enabled and not forced on all 30 tables');
SELECT pg_temp.assert_true(
  NOT has_schema_privilege('anon','public','USAGE')
  AND NOT has_schema_privilege('anon','public','CREATE'),
  'anon has no public schema access');
SELECT pg_temp.assert_true(
  NOT has_schema_privilege('authenticated','public','CREATE')
  AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_namespace n,
      LATERAL aclexplode(COALESCE(n.nspacl,acldefault('n',n.nspowner))) a
    WHERE n.nspname='public' AND a.grantee=0 AND a.privilege_type='CREATE'
  ),
  'clients and PUBLIC cannot create in public');
SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema='public' AND grantee IN ('anon','PUBLIC')
  ), 'anon/PUBLIC have no table grants');
SELECT pg_temp.assert_true(
  (SELECT count(*)=17 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prosecdef),
  'exactly 17 public SECURITY DEFINER functions');
SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.prosecdef
      AND (
        has_function_privilege('anon',p.oid,'EXECUTE')
        OR EXISTS (
          SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
          WHERE a.grantee=0 AND a.privilege_type='EXECUTE'
        )
      )
  ), 'no SECURITY DEFINER function executable by anon/PUBLIC');
SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.prosecdef
      AND (p.proconfig IS NULL OR NOT ('search_path=pg_catalog, public'=ANY(p.proconfig)))
  ), 'all SECURITY DEFINER functions have fixed trusted search_path');
SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.prosecdef
      AND pg_get_userbyid(p.proowner)<>'reachagent_function_owner'
  ), 'all SECURITY DEFINER functions use the no-login owner');
SELECT pg_temp.assert_true(
  (SELECT NOT rolcanlogin AND rolbypassrls FROM pg_catalog.pg_roles WHERE rolname='reachagent_function_owner'),
  'definer owner is NOLOGIN BYPASSRLS');
SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_default_acl d,
      LATERAL aclexplode(COALESCE(d.defaclacl,acldefault(d.defaclobjtype,d.defaclrole))) a
    WHERE pg_get_userbyid(a.grantee) IN ('anon','authenticated','service_role')
  ), 'no broad client/service default privileges');

-- Auth metadata cannot elevate. The admin fixture is promoted only by the
-- disposable database owner, standing in for the separately audited bootstrap.
INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES
  ('10000000-0000-0000-0000-000000000001','member@example.test','{"full_name":"Member","role":"admin"}'),
  ('10000000-0000-0000-0000-000000000002','admin@example.test','{"full_name":"Admin","role":"admin"}'),
  ('10000000-0000-0000-0000-000000000003','inactive@example.test','{"full_name":"Inactive","role":"admin"}');
SELECT pg_temp.assert_true(
  (SELECT role='member' AND is_active FROM public.profiles WHERE id='10000000-0000-0000-0000-000000000001'),
  'signup metadata role is ignored');
UPDATE public.profiles SET role='admin' WHERE id='10000000-0000-0000-0000-000000000002';
UPDATE public.profiles SET is_active=false WHERE id='10000000-0000-0000-0000-000000000003';

-- Seed workspace membership for the fixtures (mirrors the SaaS 1A backfill for
-- freshly created profiles: admin -> owner, member -> member, inactive -> suspended).
INSERT INTO public.workspace_members (workspace_id, user_id, role, status) VALUES
  ('00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'member', 'active'),
  ('00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'owner', 'active'),
  ('00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000003', 'member', 'suspended');

-- Synthetic roots.
INSERT INTO public.categories(id,name,status) VALUES
  ('20000000-0000-0000-0000-000000000001','Synthetic Category','active');
INSERT INTO public.city_suburbs(id,city,suburb,active) VALUES
  ('30000000-0000-0000-0000-000000000001','Sydney','Testville',true);

-- Normalization and accepted status.
INSERT INTO public.leads(
  id,business_name,category_id,category_name,city,email,status
) VALUES (
  '40000000-0000-0000-0000-000000000001','  Test Business  ',
  '20000000-0000-0000-0000-000000000001','Synthetic Category','Sydney',
  ' test@example.com ','interested'
);
SELECT pg_temp.assert_true(
  (SELECT business_name='Test Business' AND email='test@example.com' AND normalized_email='test@example.com'
   FROM public.leads WHERE id='40000000-0000-0000-0000-000000000001'),
  'lead trimming and normalized_email ordering');

INSERT INTO public.leads(id,business_name,category_name,city,email,status)
VALUES ('40000000-0000-0000-0000-000000000002','Whitespace Email','Synthetic Category','Sydney','   ','new');
SELECT pg_temp.assert_true(
  (SELECT email IS NULL AND normalized_email IS NULL FROM public.leads WHERE id='40000000-0000-0000-0000-000000000002'),
  'whitespace email becomes NULL before normalized_email');

-- Expected constraint failures.
DO $$
BEGIN
  BEGIN INSERT INTO public.city_suburbs(city,suburb,priority) VALUES ('Sydney','Bad Low',0); RAISE EXCEPTION 'priority 0 unexpectedly accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN INSERT INTO public.city_suburbs(city,suburb,priority) VALUES ('Sydney','Bad High',11); RAISE EXCEPTION 'priority 11 unexpectedly accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN INSERT INTO public.leads(business_name,category_name,city,status) VALUES ('Bad Status','Synthetic Category','Sydney','dm_queued'); RAISE EXCEPTION 'dm_queued unexpectedly accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN INSERT INTO public.leads(business_name,category_name,city,status) VALUES ('Bad Status 2','Synthetic Category','Sydney','closed_won'); RAISE EXCEPTION 'closed_won unexpectedly accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN INSERT INTO public.leads(business_name,category_id,category_name,city) VALUES ('Bad FK','ffffffff-ffff-ffff-ffff-ffffffffffff','Synthetic Category','Sydney'); RAISE EXCEPTION 'invalid category FK unexpectedly accepted'; EXCEPTION WHEN foreign_key_violation THEN NULL; END;
END
$$;

-- Updated-at and suppression behavior.
UPDATE public.categories SET updated_at='2000-01-01',name='Synthetic Category Updated' WHERE id='20000000-0000-0000-0000-000000000001';
SELECT pg_temp.assert_true((SELECT updated_at>'2000-01-02' FROM public.categories WHERE id='20000000-0000-0000-0000-000000000001'),'updated_at trigger');
UPDATE public.leads SET outreach_suppression_reason='manual',outreach_suppressed_at=now() WHERE id='40000000-0000-0000-0000-000000000001';
UPDATE public.leads SET email='owner@syntheticbakery.com' WHERE id='40000000-0000-0000-0000-000000000001';
SELECT pg_temp.assert_true(
  (SELECT outreach_suppression_reason IS NULL AND outreach_suppressed_at IS NULL FROM public.leads WHERE id='40000000-0000-0000-0000-000000000001'),
  'email change recomputes/clears suppression');

-- Data-quality trigger representative.
INSERT INTO public.leads(id,business_name,category_name,city,email,status)
VALUES ('40000000-0000-0000-0000-000000000003','Invalid Email','Synthetic Category','Sydney','not-an-email','new');
SELECT pg_temp.assert_true(
  EXISTS (SELECT 1 FROM public.lead_data_quality_flags WHERE lead_id='40000000-0000-0000-0000-000000000003' AND status='open'),
  'data-quality trigger creates an open flag');

-- Actual member RLS actions and denials.
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.role','authenticated',true);
SELECT set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',true);
INSERT INTO public.leads(id,business_name,category_name,city,status)
VALUES ('40000000-0000-0000-0000-000000000004','Member Insert','Synthetic Category','Sydney','new');
UPDATE public.leads SET status='researched' WHERE id='40000000-0000-0000-0000-000000000004';
DELETE FROM public.leads WHERE id='40000000-0000-0000-0000-000000000004';
SELECT pg_temp.assert_true(EXISTS(SELECT 1 FROM public.leads WHERE id='40000000-0000-0000-0000-000000000004'),'member delete is blocked by RLS');
SELECT pg_temp.assert_true(NOT has_table_privilege('authenticated','public.distributed_locks','INSERT'),'member cannot mutate infrastructure');
SELECT pg_temp.assert_true(NOT has_function_privilege('authenticated','public.claim_recipient_outreach(uuid,text)','EXECUTE'),'member cannot call service claim RPC');
COMMIT;

-- Inactive member write is denied.
DO $$
BEGIN
  PERFORM set_config('request.jwt.claim.role','authenticated',true);
  PERFORM set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000003',true);
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO public.leads(business_name,category_name,city) VALUES ('Inactive Insert','Synthetic Category','Sydney');
    RAISE EXCEPTION 'inactive member insert unexpectedly accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$$;

-- Active admin management and guarded RPC.
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.role','authenticated',true);
SELECT set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000002',true);
INSERT INTO public.category_suburb_priorities(category_id,city_suburb_id,priority)
VALUES ('20000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001',7);
SELECT pg_temp.assert_true(public.get_data_quality_summary() IS NOT NULL,'admin guarded report works');
SELECT public.set_data_quality_flag_status(
  'invalid_email',NULL,ARRAY['40000000-0000-0000-0000-000000000003'::uuid],
  'resolved','synthetic verification'
);
COMMIT;
SELECT pg_temp.assert_true(
  (SELECT resolved_by='10000000-0000-0000-0000-000000000002' FROM public.lead_data_quality_flags WHERE lead_id='40000000-0000-0000-0000-000000000003' ORDER BY updated_at DESC LIMIT 1),
  'admin mutation derives actor from auth.uid');

-- Service-role recipient ownership and inbound receipt claims.
BEGIN;
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.role','service_role',true);
SELECT set_config('request.jwt.claim.sub','',true);
SELECT pg_temp.assert_true(public.claim_recipient_outreach('40000000-0000-0000-0000-000000000001','initial')->>'allowed'='true','service recipient claim works');
INSERT INTO public.inbound_receipts(id,provider,receipt_key,status,payload)
VALUES ('50000000-0000-0000-0000-000000000001','hostinger','synthetic-receipt','pending','{}');
SELECT pg_temp.assert_true(
  EXISTS (SELECT 1 FROM public.claim_hostinger_inbound_receipt('50000000-0000-0000-0000-000000000001','synthetic-run',now()-interval '1 minute')),
  'service inbound receipt claim works');
COMMIT;

-- Anon and ordinary member cannot execute any SECURITY DEFINER function outside
-- the approved authenticated matrix; anon has none at all.
SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.prosecdef AND has_function_privilege('anon',p.oid,'EXECUTE')
  ), 'anon SECURITY DEFINER execute remains zero after fixtures');

SELECT 'VERIFY_CATALOG_AND_BEHAVIOR_PASS' AS result;
