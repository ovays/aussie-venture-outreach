with expected(table_name, column_name, udt_name) as (
  values
    ('leads','id','uuid'), ('leads','updated_at','timestamptz'), ('leads','status','text'),
    ('leads','category_id','uuid'), ('leads','source','text'), ('leads','email','text'),
    ('leads','normalized_email','text'), ('leads','business_name','text'),
    ('leads','category_name','text'), ('leads','city','text'), ('leads','website','text'),
    ('leads','delivery_suppressed_emails','_text'), ('leads','outreach_suppressed_at','timestamptz'),
    ('leads','outreach_suppression_reason','text'), ('leads','reactivation_sent_at','timestamptz'),
    ('emails','lead_id','uuid'), ('emails','type','text'), ('emails','status','text'),
    ('emails','sent_at','timestamptz'), ('emails','replied_at','timestamptz'),
    ('emails','created_at','timestamptz'), ('settings','key','text'), ('settings','value','text'),
    ('activity_log','lead_id','uuid'), ('activity_log','event_type','text'),
    ('activity_log','metadata','jsonb'), ('activity_log','created_at','timestamptz'),
    ('lead_data_quality_flags','lead_id','uuid'), ('lead_data_quality_flags','issue_type','text'),
    ('lead_data_quality_flags','status','text'),
    ('recipient_outreach_ownership','normalized_email','text'),
    ('recipient_outreach_ownership','owner_lead_id','uuid'), ('deals','lead_id','uuid'),
    ('categories','id','uuid'), ('category_email_templates','category_id','uuid'),
    ('category_email_templates','template_type','text'),
    ('category_email_templates','subject_template','text'),
    ('category_email_templates','body_template','text')
), required_tables(table_name) as (
  values ('activity_log'), ('categories'), ('category_email_templates'), ('deals'), ('emails'),
    ('lead_data_quality_flags'), ('leads'), ('recipient_outreach_ownership'), ('settings')
), access_rows as (
  select 'schema' as kind, n.nspname as object_name,
    coalesce(grantee.rolname, 'PUBLIC') as grantee, acl.privilege_type
  from pg_catalog.pg_namespace n
  cross join lateral pg_catalog.aclexplode(coalesce(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) acl
  left join pg_catalog.pg_roles grantee on grantee.oid = acl.grantee
  where n.nspname = 'public'
  union all
  select 'relation', format('%I.%I', n.nspname, c.relname),
    coalesce(grantee.rolname, 'PUBLIC'), acl.privilege_type
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  cross join lateral pg_catalog.aclexplode(coalesce(c.relacl,
    pg_catalog.acldefault((case when c.relkind = 'S' then 'S' else 'r' end)::"char", c.relowner))) acl
  left join pg_catalog.pg_roles grantee on grantee.oid = acl.grantee
  where n.nspname = 'public'
  union all
  select 'column', format('%I.%I.%I', n.nspname, c.relname, a.attname),
    coalesce(grantee.rolname, 'PUBLIC'), acl.privilege_type
  from pg_catalog.pg_attribute a
  join pg_catalog.pg_class c on c.oid = a.attrelid
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  cross join lateral pg_catalog.aclexplode(a.attacl) acl
  left join pg_catalog.pg_roles grantee on grantee.oid = acl.grantee
  where n.nspname = 'public' and a.attnum > 0 and not a.attisdropped
  union all
  select 'routine', format('%I.%I(%s)', n.nspname, p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid)),
    coalesce(grantee.rolname, 'PUBLIC'), acl.privilege_type
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  cross join lateral pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) acl
  left join pg_catalog.pg_roles grantee on grantee.oid = acl.grantee
  where n.nspname = 'public'
), app_role_rows as (
  select concat_ws('|', r.rolname, r.rolsuper, r.rolinherit, r.rolcreaterole,
    r.rolcreatedb, r.rolcanlogin, r.rolbypassrls) as item
  from pg_catalog.pg_roles r
  where r.rolname in ('anon','authenticated','authenticator','service_role')
  union all
  select concat_ws('|', 'membership', parent.rolname, member.rolname,
    membership.admin_option, membership.inherit_option, membership.set_option)
  from pg_catalog.pg_auth_members membership
  join pg_catalog.pg_roles parent on parent.oid = membership.roleid
  join pg_catalog.pg_roles member on member.oid = membership.member
  where parent.rolname in ('anon','authenticated','service_role')
     or member.rolname in ('anon','authenticated','service_role')
)
select jsonb_build_object(
  'public_schema_usage_for_public', exists (
    select 1 from pg_catalog.pg_namespace n
    cross join lateral pg_catalog.aclexplode(coalesce(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) acl
    where n.nspname = 'public' and acl.grantee = 0 and acl.privilege_type = 'USAGE'
  ),
  'missing_or_mismatched_columns', (
    select coalesce(jsonb_agg(jsonb_build_object(
      'table', e.table_name, 'column', e.column_name, 'expected_type', e.udt_name,
      'actual_type', c.udt_name
    ) order by e.table_name, e.column_name), '[]'::jsonb)
    from expected e
    left join information_schema.columns c
      on c.table_schema = 'public' and c.table_name = e.table_name and c.column_name = e.column_name
    where c.column_name is null or c.udt_name <> e.udt_name
  ),
  'tables_without_rls', (
    select coalesce(jsonb_agg(t.table_name order by t.table_name), '[]'::jsonb)
    from required_tables t
    left join pg_catalog.pg_class c on c.oid = pg_catalog.to_regclass(format('public.%I', t.table_name))
    where not coalesce(c.relrowsecurity, false)
  ),
  'required_table_owners', (
    select coalesce(jsonb_agg(jsonb_build_object(
      'table', t.table_name, 'owner', owner_role.rolname
    ) order by t.table_name), '[]'::jsonb)
    from required_tables t
    left join pg_catalog.pg_class c on c.oid = pg_catalog.to_regclass(format('public.%I', t.table_name))
    left join pg_catalog.pg_roles owner_role on owner_role.oid = c.relowner
  ),
  'prompt15_objects', jsonb_build_object(
    'reader_role', pg_catalog.to_regrole('reachagent_prompt15_shadow_reader') is not null,
    'view_owner_role', pg_catalog.to_regrole('reachagent_prompt15_shadow_view_owner') is not null,
    'schema', pg_catalog.to_regnamespace('reachagent_prompt15_shadow') is not null,
    'policy_count', (select count(*) from pg_catalog.pg_policies where schemaname = 'public' and policyname like 'prompt15_shadow_%')
  ),
  'public_base_select_grant_count', (
    select count(*) from information_schema.table_privileges
    where table_schema = 'public' and grantee = 'PUBLIC' and privilege_type = 'SELECT'
  ),
  'public_column_select_grant_count', (
    select count(*) from information_schema.column_privileges
    where table_schema = 'public' and grantee = 'PUBLIC' and privilege_type = 'SELECT'
  ),
  'public_routine_execute_grant_count', (
    select count(*)
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    cross join lateral pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) acl
    where n.nspname = 'public'
      and acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
  ),
  'public_sequence_privilege_count', (
    select count(*)
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    cross join lateral pg_catalog.aclexplode(coalesce(c.relacl, pg_catalog.acldefault('S', c.relowner))) acl
    where n.nspname = 'public' and c.relkind = 'S'
      and acl.grantee = 0 and acl.privilege_type in ('USAGE','SELECT','UPDATE')
  ),
  'existing_access_fingerprint', (
    select encode(extensions.digest(coalesce(string_agg(
      concat_ws('|', kind, object_name, grantee, privilege_type), E'\n'
      order by kind, object_name, grantee, privilege_type
    ), ''), 'sha256'), 'hex') from access_rows
    where grantee not in ('reachagent_prompt15_shadow_reader', 'reachagent_prompt15_shadow_view_owner')
  ),
  'existing_policy_fingerprint', (
    select encode(extensions.digest(coalesce(string_agg(
      concat_ws('|', schemaname, tablename, policyname, permissive, roles::text, cmd, qual, with_check),
      E'\n' order by schemaname, tablename, policyname
    ), ''), 'sha256'), 'hex')
    from pg_catalog.pg_policies
    where schemaname = 'public' and policyname not like 'prompt15_shadow_%'
  ),
  'application_role_fingerprint', (
    select encode(extensions.digest(coalesce(string_agg(item, E'\n' order by item), ''), 'sha256'), 'hex')
    from app_role_rows
  )
) as safety_snapshot;
