select jsonb_build_object(
  'role_exists', pg_catalog.to_regrole('reachagent_prompt15_shadow_reader') is not null,
  'view_owner_role_exists', pg_catalog.to_regrole('reachagent_prompt15_shadow_view_owner') is not null,
  'schema_exists', pg_catalog.to_regnamespace('reachagent_prompt15_shadow') is not null,
  'view_count', (
    select count(*) from pg_catalog.pg_views where schemaname = 'reachagent_prompt15_shadow'
  ),
  'policy_count', (
    select count(*) from pg_catalog.pg_policies
    where schemaname = 'public' and policyname like 'prompt15_shadow_%'
  ),
  'authenticator_membership', exists (
    select 1 from pg_catalog.pg_auth_members membership
    join pg_catalog.pg_roles parent on parent.oid = membership.roleid
    join pg_catalog.pg_roles member on member.oid = membership.member
    where parent.rolname = 'reachagent_prompt15_shadow_reader' and member.rolname = 'authenticator'
  )
) as object_state;
