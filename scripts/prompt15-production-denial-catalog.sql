with required_tables(table_name) as (
  values ('activity_log'), ('categories'), ('category_email_templates'), ('deals'), ('emails'),
    ('lead_data_quality_flags'), ('leads'), ('recipient_outreach_ownership'), ('settings')
), expected_columns(table_name, column_name) as (
  values
    ('leads','id'), ('leads','updated_at'), ('leads','status'), ('leads','category_id'),
    ('leads','source'), ('leads','email'), ('leads','normalized_email'),
    ('leads','business_name'), ('leads','category_name'), ('leads','city'),
    ('leads','website'), ('leads','delivery_suppressed_emails'),
    ('leads','outreach_suppressed_at'), ('leads','outreach_suppression_reason'),
    ('leads','reactivation_sent_at'),
    ('emails','lead_id'), ('emails','type'), ('emails','status'), ('emails','sent_at'),
    ('emails','replied_at'), ('emails','created_at'),
    ('settings','key'), ('settings','value'),
    ('activity_log','lead_id'), ('activity_log','event_type'), ('activity_log','metadata'),
    ('activity_log','created_at'),
    ('lead_data_quality_flags','lead_id'), ('lead_data_quality_flags','issue_type'),
    ('lead_data_quality_flags','status'),
    ('recipient_outreach_ownership','normalized_email'),
    ('recipient_outreach_ownership','owner_lead_id'),
    ('deals','lead_id'), ('categories','id'),
    ('category_email_templates','category_id'),
    ('category_email_templates','template_type'),
    ('category_email_templates','subject_template'),
    ('category_email_templates','body_template')
), expected_views(view_name) as (
  values ('lead_facts'), ('email_facts'), ('decision_settings'), ('mode_snapshots'),
    ('duplicate_flags'), ('deal_leads'), ('category_initial_template_facts')
), role_names(role_name) as (
  values ('reachagent_prompt15_shadow_reader'), ('reachagent_prompt15_shadow_view_owner')
)
select jsonb_build_object(
  'role_attributes', (
    select jsonb_object_agg(r.rolname, jsonb_build_object(
      'login', r.rolcanlogin, 'superuser', r.rolsuper, 'inherit', r.rolinherit,
      'createrole', r.rolcreaterole, 'createdb', r.rolcreatedb, 'bypassrls', r.rolbypassrls
    )) from pg_catalog.pg_roles r where r.rolname in (select role_name from role_names)
  ),
  'public_schema_usage', has_schema_privilege('reachagent_prompt15_shadow_reader', 'public', 'USAGE'),
  'reader_shadow_schema_usage', has_schema_privilege('reachagent_prompt15_shadow_reader', 'reachagent_prompt15_shadow', 'USAGE'),
  'reader_shadow_schema_create', has_schema_privilege('reachagent_prompt15_shadow_reader', 'reachagent_prompt15_shadow', 'CREATE'),
  'view_owner_shadow_schema_usage', has_schema_privilege('reachagent_prompt15_shadow_view_owner', 'reachagent_prompt15_shadow', 'USAGE'),
  'authenticator_can_assume_reader', pg_has_role('authenticator', 'reachagent_prompt15_shadow_reader', 'MEMBER'),
  'authenticator_can_assume_view_owner', pg_has_role('authenticator', 'reachagent_prompt15_shadow_view_owner', 'MEMBER'),
  'reader_can_assume_view_owner', pg_has_role('reachagent_prompt15_shadow_reader', 'reachagent_prompt15_shadow_view_owner', 'MEMBER'),
  'application_membership_count', (
    select count(*) from role_names r cross join (values ('anon'),('authenticated'),('service_role')) a(role_name)
    where pg_has_role(r.role_name, a.role_name, 'MEMBER')
  ),
  'rls_missing_count', (
    select count(*) from required_tables t
    left join pg_catalog.pg_class c on c.oid = pg_catalog.to_regclass(format('public.%I', t.table_name))
    where not coalesce(c.relrowsecurity, false)
  ),
  'base_table_owner_count', (
    select count(*) from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    join pg_catalog.pg_roles r on r.oid = c.relowner
    where n.nspname = 'public' and c.relkind in ('r','p') and r.rolname in (select role_name from role_names)
  ),
  'view_count', (select count(*) from pg_catalog.pg_views where schemaname = 'reachagent_prompt15_shadow'),
  'view_owner_count', (
    select count(*) from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    join pg_catalog.pg_roles r on r.oid = c.relowner
    where n.nspname = 'reachagent_prompt15_shadow' and c.relkind = 'v'
      and r.rolname = 'reachagent_prompt15_shadow_view_owner'
  ),
  'unexpected_view_count', (
    select count(*) from pg_catalog.pg_views v where v.schemaname = 'reachagent_prompt15_shadow'
      and v.viewname not in (select view_name from expected_views)
  ),
  'security_invoker_view_count', (
    select count(*) from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'reachagent_prompt15_shadow' and c.relkind = 'v'
      and coalesce(c.reloptions, '{}') @> array['security_invoker=true']
  ),
  'security_barrier_view_count', (
    select count(*) from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'reachagent_prompt15_shadow' and c.relkind = 'v'
      and coalesce(c.reloptions, '{}') @> array['security_barrier=true']
  ),
  'view_owner_select_policy_count', (
    select count(*) from pg_catalog.pg_policies where schemaname = 'public'
      and policyname like 'prompt15_shadow_%' and cmd = 'SELECT'
      and roles = array['reachagent_prompt15_shadow_view_owner']::name[]
  ),
  'reader_policy_count', (
    select count(*) from pg_catalog.pg_policies where schemaname = 'public'
      and 'reachagent_prompt15_shadow_reader' = any(roles)
  ),
  'reader_public_table_select_count', (
    select count(*) from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r','p')
      and has_table_privilege('reachagent_prompt15_shadow_reader', c.oid, 'SELECT')
  ),
  'reader_public_column_select_count', (
    select count(*) from pg_catalog.pg_attribute a join pg_catalog.pg_class c on c.oid = a.attrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r','p') and a.attnum > 0 and not a.attisdropped
      and has_column_privilege('reachagent_prompt15_shadow_reader', c.oid, a.attnum, 'SELECT')
  ),
  'view_owner_exact_select_column_count', (
    select count(*) from information_schema.column_privileges p
    join expected_columns e on e.table_name = p.table_name and e.column_name = p.column_name
    where p.table_schema = 'public' and p.grantee = 'reachagent_prompt15_shadow_view_owner'
      and p.privilege_type = 'SELECT'
  ),
  'view_owner_unexpected_column_privilege_count', (
    select count(*) from information_schema.column_privileges p
    left join expected_columns e on e.table_name = p.table_name and e.column_name = p.column_name
    where p.table_schema = 'public' and p.grantee = 'reachagent_prompt15_shadow_view_owner'
      and (p.privilege_type <> 'SELECT' or e.column_name is null)
  ),
  'write_privilege_count', (
    select count(*) from role_names r cross join pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname not in ('pg_catalog','information_schema') and c.relkind in ('r','p','v','m','f')
      and (has_table_privilege(r.role_name, c.oid, 'INSERT') or has_table_privilege(r.role_name, c.oid, 'UPDATE')
        or has_table_privilege(r.role_name, c.oid, 'DELETE') or has_table_privilege(r.role_name, c.oid, 'TRUNCATE'))
  ),
  'sequence_privilege_count', (
    select count(*) from role_names r cross join pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname not in ('pg_catalog','information_schema') and c.relkind = 'S'
      and (has_sequence_privilege(r.role_name, c.oid, 'USAGE') or has_sequence_privilege(r.role_name, c.oid, 'SELECT')
        or has_sequence_privilege(r.role_name, c.oid, 'UPDATE'))
  ),
  'routine_execute_privilege_count', (
    select count(*) from role_names r cross join pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public','reachagent_prompt15_shadow')
      and has_function_privilege(r.role_name, p.oid, 'EXECUTE')
  ),
  'shadow_routine_count', (
    select count(*) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'reachagent_prompt15_shadow'
  ),
  'shadow_sequence_count', (
    select count(*) from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'reachagent_prompt15_shadow' and c.relkind = 'S'
  )
) as denial_catalog;
