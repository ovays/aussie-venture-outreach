select jsonb_build_object(
  'server_version', current_setting('server_version'),
  'required_tables', (
    select jsonb_agg(jsonb_build_object(
      'table_name', t.table_name,
      'rls_enabled', c.relrowsecurity,
      'rls_forced', c.relforcerowsecurity,
      'columns', (
        select jsonb_agg(jsonb_build_object(
          'name', col.column_name,
          'type', col.data_type,
          'udt', col.udt_name,
          'nullable', col.is_nullable
        ) order by col.ordinal_position)
        from information_schema.columns col
        where col.table_schema = 'public' and col.table_name = t.table_name
      )
    ) order by t.table_name)
    from (values
      ('activity_log'),
      ('categories'),
      ('category_email_templates'),
      ('deals'),
      ('emails'),
      ('lead_data_quality_flags'),
      ('leads'),
      ('recipient_outreach_ownership'),
      ('settings')
    ) as t(table_name)
    left join pg_catalog.pg_class c
      on c.oid = pg_catalog.to_regclass(format('public.%I', t.table_name))
  ),
  'platform_roles', (
    select jsonb_agg(jsonb_build_object(
      'name', r.rolname,
      'login', r.rolcanlogin,
      'inherit', r.rolinherit,
      'superuser', r.rolsuper,
      'createrole', r.rolcreaterole,
      'createdb', r.rolcreatedb,
      'bypassrls', r.rolbypassrls
    ) order by r.rolname)
    from pg_catalog.pg_roles r
    where r.rolname in ('anon', 'authenticated', 'authenticator', 'service_role')
  ),
  'shadow_role_exists', pg_catalog.to_regrole('reachagent_prompt15_shadow_reader') is not null,
  'shadow_view_owner_role_exists', pg_catalog.to_regrole('reachagent_prompt15_shadow_view_owner') is not null,
  'shadow_schema_exists', pg_catalog.to_regnamespace('reachagent_prompt15_shadow') is not null,
  'data_api_role_settings', (
    select coalesce(jsonb_agg(s order by s), '[]'::jsonb)
    from (
      select unnest(rs.setconfig) as s
      from pg_catalog.pg_db_role_setting rs
      join pg_catalog.pg_roles r on r.oid = rs.setrole
      where r.rolname = 'authenticator'
        and exists (
          select 1 from unnest(rs.setconfig) item
          where item like 'pgrst.db_schemas=%'
        )
    ) settings
  ),
  'existing_policy_fingerprint', (
    select encode(extensions.digest(coalesce(string_agg(
      concat_ws('|', schemaname, tablename, policyname, permissive, roles::text, cmd, qual, with_check),
      E'\n' order by schemaname, tablename, policyname
    ), ''), 'sha256'), 'hex')
    from pg_catalog.pg_policies
    where schemaname = 'public'
  ),
  'existing_grant_fingerprint', (
    select encode(extensions.digest(coalesce(string_agg(
      concat_ws('|', table_schema, table_name, grantee, privilege_type, is_grantable),
      E'\n' order by table_schema, table_name, grantee, privilege_type
    ), ''), 'sha256'), 'hex')
    from information_schema.table_privileges
    where table_schema = 'public'
  )
) as preflight;
