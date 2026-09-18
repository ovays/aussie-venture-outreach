\set ON_ERROR_STOP on

create role authenticator login noinherit nosuperuser nocreatedb nocreaterole;
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant anon, authenticated, service_role to authenticator;

-- Match the V1 production baseline exactly: every role receives public-schema
-- USAGE through PostgreSQL PUBLIC. V2 must remain safe under this condition.
revoke all on schema public from public;
grant usage on schema public to public;

create table public.categories (
  id uuid primary key,
  name text not null
);

create table public.leads (
  id uuid primary key,
  business_name text not null,
  category_id uuid references public.categories(id),
  category_name text,
  city text,
  website text,
  email text,
  normalized_email text,
  phone text,
  address text,
  source text,
  status text,
  delivery_suppressed_emails text[] default '{}',
  outreach_suppressed_at timestamptz,
  outreach_suppression_reason text,
  reactivation_sent_at timestamptz,
  updated_at timestamptz not null default now()
);

create table public.emails (
  id uuid primary key,
  lead_id uuid references public.leads(id),
  type text not null,
  status text not null,
  subject text not null,
  body_html text not null,
  body_text text,
  provider_message_id text,
  sent_at timestamptz,
  replied_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.settings (
  key text primary key,
  value text not null,
  description text
);

create table public.activity_log (
  id uuid primary key,
  event_type text not null,
  lead_id uuid references public.leads(id),
  description text not null,
  metadata jsonb,
  created_at timestamptz not null default now()
);

create table public.lead_data_quality_flags (
  id uuid primary key,
  lead_id uuid references public.leads(id),
  issue_type text not null,
  status text not null,
  metadata jsonb
);

create table public.recipient_outreach_ownership (
  normalized_email text primary key,
  owner_lead_id uuid references public.leads(id),
  metadata jsonb
);

create table public.deals (
  id uuid primary key,
  lead_id uuid references public.leads(id),
  deal_value numeric(10,2)
);

create table public.category_email_templates (
  category_id uuid references public.categories(id),
  template_type text not null,
  subject_template text,
  body_template text,
  primary key (category_id, template_type)
);

create table public.ai_provider_credentials (
  provider text primary key,
  api_key text not null,
  system_prompt text not null
);

create sequence public.danger_sequence;

create function public.claim_recipient_outreach(p_lead_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.leads set status = 'contacted' where id = p_lead_id;
  return found;
end;
$$;

revoke all on function public.claim_recipient_outreach(uuid) from public, anon;
grant execute on function public.claim_recipient_outreach(uuid) to authenticated, service_role;

alter table public.categories enable row level security;
alter table public.leads enable row level security;
alter table public.emails enable row level security;
alter table public.settings enable row level security;
alter table public.activity_log enable row level security;
alter table public.lead_data_quality_flags enable row level security;
alter table public.recipient_outreach_ownership enable row level security;
alter table public.deals enable row level security;
alter table public.category_email_templates enable row level security;
alter table public.ai_provider_credentials enable row level security;

grant select, insert, update, delete on all tables in schema public to authenticated, service_role;
grant usage, select on all sequences in schema public to authenticated, service_role;

create policy authenticated_categories on public.categories to authenticated using (true) with check (true);
create policy authenticated_leads on public.leads to authenticated using (true) with check (true);
create policy authenticated_emails on public.emails to authenticated using (true) with check (true);
create policy authenticated_settings on public.settings to authenticated using (true) with check (true);
create policy authenticated_activity on public.activity_log to authenticated using (true) with check (true);
create policy authenticated_flags on public.lead_data_quality_flags to authenticated using (true) with check (true);
create policy authenticated_ownership on public.recipient_outreach_ownership to authenticated using (true) with check (true);
create policy authenticated_deals on public.deals to authenticated using (true) with check (true);
create policy authenticated_templates on public.category_email_templates to authenticated using (true) with check (true);
create policy authenticated_credentials on public.ai_provider_credentials to authenticated using (true) with check (true);

insert into public.categories(id, name) values
  ('10000000-0000-0000-0000-000000000001', 'Experiences');

insert into public.leads(
  id, business_name, category_id, category_name, city, website, email,
  normalized_email, phone, address, source, status, delivery_suppressed_emails,
  outreach_suppressed_at, outreach_suppression_reason, reactivation_sent_at,
  updated_at
) values
  (
    '20000000-0000-0000-0000-000000000001', 'Visible Business',
    '10000000-0000-0000-0000-000000000001', 'Experiences', 'Sydney',
    'https://visible.invalid', 'owner@example.invalid', 'owner@example.invalid',
    '+61 400 000 001', '1 Secret Street', 'finder', 'contacted', '{}', null,
    null, null, now()
  ),
  (
    '20000000-0000-0000-0000-000000000002', 'Shared Recipient',
    '10000000-0000-0000-0000-000000000001', 'Experiences', 'Sydney',
    'https://shared.invalid', 'owner@example.invalid', 'owner@example.invalid',
    '+61 400 000 002', '2 Secret Street', 'manual', 'new',
    array['owner@example.invalid'], null, null, null, now() - interval '1 day'
  );

insert into public.emails(
  id, lead_id, type, status, subject, body_html, body_text,
  provider_message_id, sent_at, replied_at, created_at
) values
  (
    '30000000-0000-0000-0000-000000000001',
    '20000000-0000-0000-0000-000000000001', 'initial_pitch', 'sent',
    'SECRET SUBJECT', '<p>SECRET CUSTOMER EMAIL BODY</p>',
    'SECRET CUSTOMER EMAIL BODY', 'provider-secret-id',
    now() - interval '22 days', null, now() - interval '22 days'
  ),
  (
    '30000000-0000-0000-0000-000000000002',
    '20000000-0000-0000-0000-000000000001', 'internal_draft', 'draft',
    'HIDDEN DRAFT', '<p>HIDDEN DRAFT BODY</p>', 'HIDDEN DRAFT BODY', null,
    null, null, now()
  );

insert into public.settings(key, value, description) values
  ('initial_email_mode', 'template', 'Decision setting'),
  ('follow_up_1_days', '7', 'Decision setting'),
  ('follow_up_2_days', '14', 'Decision setting'),
  ('follow_up_3_days', '21', 'Decision setting'),
  ('dead_lead_days', '45', 'Decision setting'),
  ('reactivation_enabled', 'true', 'Decision setting'),
  ('reactivation_delay_days', '60', 'Decision setting'),
  ('dead_after_reactivation_days', '14', 'Decision setting'),
  ('openai_api_key', 'PROVIDER-CREDENTIAL-MUST-NOT-LEAK', 'Sensitive');

insert into public.activity_log(id, event_type, lead_id, description, metadata, created_at) values
  (
    '40000000-0000-0000-0000-000000000001', 'initial_email_mode_snapshot',
    '20000000-0000-0000-0000-000000000001', 'Mode snapshot',
    '{"initial_email_mode":"template","prompt":"SECRET PROMPT"}', now()
  ),
  (
    '40000000-0000-0000-0000-000000000002', 'ai_request',
    '20000000-0000-0000-0000-000000000001', 'Sensitive AI event',
    '{"prompt":"SECRET AI PROMPT","response":"SECRET AI RESPONSE"}', now()
  );

insert into public.lead_data_quality_flags(id, lead_id, issue_type, status, metadata) values
  (
    '50000000-0000-0000-0000-000000000001',
    '20000000-0000-0000-0000-000000000002', 'duplicate_lead', 'open',
    '{"private_reason":"SECRET"}'
  ),
  (
    '50000000-0000-0000-0000-000000000002',
    '20000000-0000-0000-0000-000000000001', 'phone_mismatch', 'open',
    '{"private_reason":"SECRET"}'
  );

insert into public.recipient_outreach_ownership(normalized_email, owner_lead_id, metadata) values
  ('owner@example.invalid', '20000000-0000-0000-0000-000000000001', '{"claim_token":"SECRET"}');

insert into public.deals(id, lead_id, deal_value) values
  ('60000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 1000);

insert into public.category_email_templates(category_id, template_type, subject_template, body_template) values
  (
    '10000000-0000-0000-0000-000000000001', 'initial_pitch',
    'Hello {{business_name}}',
    'A private template body for {{business_name}} in {{city}}.'
  );

insert into public.ai_provider_credentials(provider, api_key, system_prompt) values
  ('openai', 'sk-secret-provider-key', 'SECRET SYSTEM PROMPT');

create role reachagent_prompt15_shadow_reader
  nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
create role reachagent_prompt15_shadow_view_owner
  nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;

grant reachagent_prompt15_shadow_reader to authenticator;

create schema reachagent_prompt15_shadow authorization postgres;
revoke all on schema reachagent_prompt15_shadow from public, anon, authenticated, service_role;
revoke create on schema reachagent_prompt15_shadow from public;
grant usage on schema reachagent_prompt15_shadow to reachagent_prompt15_shadow_reader;

-- Only the dedicated view owner receives base-table privileges. The external
-- reader deliberately receives zero table and column privileges in public.
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
    and t.subject_template !~ E'[\\r\\n]'
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
