begin;

do $prompt15_preflight$
declare
  missing_count integer;
  rls_missing_count integer;
begin
  if pg_catalog.to_regrole('reachagent_prompt15_shadow_reader') is not null then
    raise exception 'Prompt 15 reader role already exists';
  end if;
  if pg_catalog.to_regrole('reachagent_prompt15_shadow_view_owner') is not null then
    raise exception 'Prompt 15 view-owner role already exists';
  end if;
  if pg_catalog.to_regnamespace('reachagent_prompt15_shadow') is not null then
    raise exception 'Prompt 15 shadow schema already exists';
  end if;

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
  )
  select count(*) into missing_count
  from expected e
  left join information_schema.columns c
    on c.table_schema = 'public' and c.table_name = e.table_name and c.column_name = e.column_name
  where c.column_name is null or c.udt_name <> e.udt_name;
  if missing_count <> 0 then
    raise exception 'Prompt 15 required production columns do not match the rehearsed model';
  end if;

  with required_tables(table_name) as (
    values ('activity_log'), ('categories'), ('category_email_templates'), ('deals'), ('emails'),
      ('lead_data_quality_flags'), ('leads'), ('recipient_outreach_ownership'), ('settings')
  )
  select count(*) into rls_missing_count
  from required_tables t
  left join pg_catalog.pg_class c on c.oid = pg_catalog.to_regclass(format('public.%I', t.table_name))
  where not coalesce(c.relrowsecurity, false);
  if rls_missing_count <> 0 then
    raise exception 'Prompt 15 requires RLS on every required production table';
  end if;
end
$prompt15_preflight$;

create role reachagent_prompt15_shadow_reader
  nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
create role reachagent_prompt15_shadow_view_owner
  nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
grant reachagent_prompt15_shadow_reader to authenticator;

create schema reachagent_prompt15_shadow authorization postgres;
revoke all on schema reachagent_prompt15_shadow from public, anon, authenticated, service_role;
revoke create on schema reachagent_prompt15_shadow from public;
grant usage on schema reachagent_prompt15_shadow to reachagent_prompt15_shadow_reader;

grant select (
  id, updated_at, status, category_id, source, email, normalized_email,
  business_name, category_name, city, website, delivery_suppressed_emails,
  outreach_suppressed_at, outreach_suppression_reason, reactivation_sent_at
) on public.leads to reachagent_prompt15_shadow_view_owner;
grant select (lead_id, type, status, sent_at, replied_at, created_at)
  on public.emails to reachagent_prompt15_shadow_view_owner;
grant select (key, value) on public.settings to reachagent_prompt15_shadow_view_owner;
grant select (lead_id, event_type, metadata, created_at)
  on public.activity_log to reachagent_prompt15_shadow_view_owner;
grant select (lead_id, issue_type, status)
  on public.lead_data_quality_flags to reachagent_prompt15_shadow_view_owner;
grant select (normalized_email, owner_lead_id)
  on public.recipient_outreach_ownership to reachagent_prompt15_shadow_view_owner;
grant select (lead_id) on public.deals to reachagent_prompt15_shadow_view_owner;
grant select (id) on public.categories to reachagent_prompt15_shadow_view_owner;
grant select (category_id, template_type, subject_template, body_template)
  on public.category_email_templates to reachagent_prompt15_shadow_view_owner;

create policy prompt15_shadow_select_leads on public.leads
  for select to reachagent_prompt15_shadow_view_owner using (true);
create policy prompt15_shadow_select_emails on public.emails
  for select to reachagent_prompt15_shadow_view_owner
  using (
    type in ('initial_pitch','follow_up_1','follow_up_2','follow_up_3','reactivation')
    and status in ('pending_send','sent','email_sync_failed')
  );
create policy prompt15_shadow_select_settings on public.settings
  for select to reachagent_prompt15_shadow_view_owner
  using (
    key in (
      'initial_email_mode','follow_up_1_days','follow_up_2_days','follow_up_3_days',
      'dead_lead_days','reactivation_enabled','reactivation_delay_days',
      'dead_after_reactivation_days'
    )
  );
create policy prompt15_shadow_select_mode_snapshots on public.activity_log
  for select to reachagent_prompt15_shadow_view_owner
  using (event_type = 'initial_email_mode_snapshot');
create policy prompt15_shadow_select_duplicate_flags on public.lead_data_quality_flags
  for select to reachagent_prompt15_shadow_view_owner
  using (status = 'open' and issue_type = 'duplicate_lead');
create policy prompt15_shadow_select_ownership on public.recipient_outreach_ownership
  for select to reachagent_prompt15_shadow_view_owner using (true);
create policy prompt15_shadow_select_deals on public.deals
  for select to reachagent_prompt15_shadow_view_owner using (true);
create policy prompt15_shadow_select_categories on public.categories
  for select to reachagent_prompt15_shadow_view_owner using (true);
create policy prompt15_shadow_select_initial_templates on public.category_email_templates
  for select to reachagent_prompt15_shadow_view_owner
  using (template_type = 'initial_pitch');

create view reachagent_prompt15_shadow.lead_facts
with (security_barrier = true)
as
select
  l.id,
  l.updated_at,
  l.status,
  l.category_id,
  l.source,
  l.reactivation_sent_at,
  nullif(btrim(l.email), '') is not null as has_email,
  nullif(btrim(l.business_name), '') is not null as has_business_name,
  nullif(btrim(l.category_name), '') is not null as has_category_name,
  nullif(btrim(l.city), '') is not null as has_city,
  nullif(btrim(l.website), '') is not null as has_website,
  (
    l.outreach_suppressed_at is not null
    or nullif(btrim(l.outreach_suppression_reason), '') is not null
    or coalesce(l.normalized_email = any(l.delivery_suppressed_emails), false)
  ) as suppressed,
  case
    when l.normalized_email is null then 'unclaimed'
    when o.normalized_email is null then 'unclaimed'
    when o.owner_lead_id = l.id then 'owned_by_lead'
    else 'owned_by_other'
  end as recipient_ownership
from public.leads l
left join public.recipient_outreach_ownership o
  on o.normalized_email = l.normalized_email;

create view reachagent_prompt15_shadow.email_facts
with (security_barrier = true)
as
select lead_id, type, status, sent_at, replied_at, created_at
from public.emails
where type in ('initial_pitch','follow_up_1','follow_up_2','follow_up_3','reactivation')
  and status in ('pending_send','sent','email_sync_failed');

create view reachagent_prompt15_shadow.decision_settings
with (security_barrier = true)
as
select key, value
from public.settings
where key in (
  'initial_email_mode','follow_up_1_days','follow_up_2_days','follow_up_3_days',
  'dead_lead_days','reactivation_enabled','reactivation_delay_days',
  'dead_after_reactivation_days'
);

create view reachagent_prompt15_shadow.mode_snapshots
with (security_barrier = true)
as
select lead_id, metadata ->> 'initial_email_mode' as initial_email_mode, created_at
from public.activity_log
where event_type = 'initial_email_mode_snapshot';

create view reachagent_prompt15_shadow.duplicate_flags
with (security_barrier = true)
as
select distinct lead_id
from public.lead_data_quality_flags
where status = 'open' and issue_type = 'duplicate_lead';

create view reachagent_prompt15_shadow.deal_leads
with (security_barrier = true)
as
select distinct lead_id from public.deals where lead_id is not null;

create view reachagent_prompt15_shadow.category_initial_template_facts
with (security_barrier = true)
as
select
  t.category_id,
  (
    nullif(btrim(t.subject_template), '') is not null
    and nullif(btrim(t.body_template), '') is not null
    and t.subject_template !~ E'[\r\n]'
    and regexp_replace(t.subject_template, E'\\{\\{[a-z][a-z0-9_]*\\}\\}', '', 'g') !~ '[{}]'
    and regexp_replace(t.body_template, E'\\{\\{[a-z][a-z0-9_]*\\}\\}', '', 'g') !~ '[{}]'
    and not exists (
      select 1
      from regexp_matches(
        coalesce(t.subject_template, '') || coalesce(t.body_template, ''),
        E'\\{\\{([a-z][a-z0-9_]*)\\}\\}', 'g'
      ) as found
      where found[1] <> all(array[
        'business_name','contact_name','category_name','city','website'
      ])
    )
  ) as template_ready,
  array(
    select distinct found[1]
    from regexp_matches(
      coalesce(t.subject_template, '') || coalesce(t.body_template, ''),
      E'\\{\\{([a-z][a-z0-9_]*)\\}\\}', 'g'
    ) as found
    order by found[1]
  ) as required_placeholders
from public.category_email_templates t
join public.categories c on c.id = t.category_id
where t.template_type = 'initial_pitch';

alter view reachagent_prompt15_shadow.lead_facts owner to reachagent_prompt15_shadow_view_owner;
alter view reachagent_prompt15_shadow.email_facts owner to reachagent_prompt15_shadow_view_owner;
alter view reachagent_prompt15_shadow.decision_settings owner to reachagent_prompt15_shadow_view_owner;
alter view reachagent_prompt15_shadow.mode_snapshots owner to reachagent_prompt15_shadow_view_owner;
alter view reachagent_prompt15_shadow.duplicate_flags owner to reachagent_prompt15_shadow_view_owner;
alter view reachagent_prompt15_shadow.deal_leads owner to reachagent_prompt15_shadow_view_owner;
alter view reachagent_prompt15_shadow.category_initial_template_facts owner to reachagent_prompt15_shadow_view_owner;

revoke all on all tables in schema reachagent_prompt15_shadow
  from public, anon, authenticated, service_role, reachagent_prompt15_shadow_reader;
grant select on
  reachagent_prompt15_shadow.lead_facts,
  reachagent_prompt15_shadow.email_facts,
  reachagent_prompt15_shadow.decision_settings,
  reachagent_prompt15_shadow.mode_snapshots,
  reachagent_prompt15_shadow.duplicate_flags,
  reachagent_prompt15_shadow.deal_leads,
  reachagent_prompt15_shadow.category_initial_template_facts
to reachagent_prompt15_shadow_reader;
revoke all on all functions in schema reachagent_prompt15_shadow
  from public, anon, authenticated, service_role,
       reachagent_prompt15_shadow_reader, reachagent_prompt15_shadow_view_owner;
revoke all on all sequences in schema reachagent_prompt15_shadow
  from public, anon, authenticated, service_role,
       reachagent_prompt15_shadow_reader, reachagent_prompt15_shadow_view_owner;

notify pgrst, 'reload schema';
commit;
