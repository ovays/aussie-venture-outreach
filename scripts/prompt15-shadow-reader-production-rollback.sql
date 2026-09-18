begin;
do $prompt15_revoke$
begin
  if pg_catalog.to_regrole('reachagent_prompt15_shadow_reader') is not null then
    execute 'revoke reachagent_prompt15_shadow_reader from authenticator';
  end if;
end
$prompt15_revoke$;
drop policy if exists prompt15_shadow_select_leads on public.leads;
drop policy if exists prompt15_shadow_select_emails on public.emails;
drop policy if exists prompt15_shadow_select_settings on public.settings;
drop policy if exists prompt15_shadow_select_mode_snapshots on public.activity_log;
drop policy if exists prompt15_shadow_select_duplicate_flags on public.lead_data_quality_flags;
drop policy if exists prompt15_shadow_select_ownership on public.recipient_outreach_ownership;
drop policy if exists prompt15_shadow_select_deals on public.deals;
drop policy if exists prompt15_shadow_select_categories on public.categories;
drop policy if exists prompt15_shadow_select_initial_templates on public.category_email_templates;
drop schema if exists reachagent_prompt15_shadow cascade;
do $prompt15_drop_role$
begin
  if pg_catalog.to_regrole('reachagent_prompt15_shadow_reader') is not null then
    execute format('grant reachagent_prompt15_shadow_reader to %I', current_user);
    execute 'drop owned by reachagent_prompt15_shadow_reader';
    execute 'drop role reachagent_prompt15_shadow_reader';
  end if;
end
$prompt15_drop_role$;
do $prompt15_drop_view_owner_role$
begin
  if pg_catalog.to_regrole('reachagent_prompt15_shadow_view_owner') is not null then
    execute format('grant reachagent_prompt15_shadow_view_owner to %I', current_user);
    execute 'drop owned by reachagent_prompt15_shadow_view_owner';
    execute 'drop role reachagent_prompt15_shadow_view_owner';
  end if;
end
$prompt15_drop_view_owner_role$;
notify pgrst, 'reload schema';
commit;
