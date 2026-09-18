-- Prompt 15 sanitized-snapshot local fixture.
--
-- Schema-compatible re-creation of the V1 public tables that
-- scripts/prompt15-sanitized-snapshot.sql reads. Column names, types, and the
-- relevant uniqueness constraints mirror docs/reachagent-live-schema-only.sql.
--
-- Every lead carries deliberately sensitive values (real-looking emails, business
-- names, phones, addresses, websites, subjects, bodies, metadata blobs, API keys)
-- so the privacy scan in scripts/prompt15-snapshot-safety.ts is proved against
-- data that would fail if the query ever leaked a source column.
--
-- This fixture never touches V1. Apply it only to the disposable local database.

drop schema if exists public cascade;
create schema public;

create table public.categories (
  id uuid primary key,
  name text not null
);

create table public.category_email_templates (
  id uuid primary key,
  category_id uuid not null references public.categories(id) on delete cascade,
  template_type text not null,
  subject_template text,
  body_template text,
  constraint category_email_templates_category_type_unique unique (category_id, template_type)
);

create table public.leads (
  id uuid primary key,
  business_name text not null,
  category_id uuid,
  category_name text not null,
  address text,
  city text not null,
  phone text,
  email text,
  website text,
  status text not null,
  source text,
  notes text,
  reactivation_sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  delivery_suppressed_emails text[] not null default '{}',
  normalized_email text,
  outreach_suppression_reason text,
  outreach_suppressed_at timestamptz
);

create table public.emails (
  id uuid primary key,
  lead_id uuid references public.leads(id) on delete cascade,
  type text not null,
  subject text not null,
  body_html text not null,
  body_text text not null,
  status text not null default 'pending_send',
  sent_at timestamptz,
  opened_at timestamptz,
  replied_at timestamptz,
  created_at timestamptz not null default now(),
  message_id text
);

create table public.settings (
  id uuid primary key,
  key text not null unique,
  value text not null,
  description text
);

create table public.activity_log (
  id uuid primary key,
  event_type text not null,
  lead_id uuid,
  description text not null,
  metadata jsonb,
  created_at timestamptz not null default now()
);

create table public.lead_data_quality_flags (
  id uuid primary key,
  lead_id uuid not null,
  normalized_email text,
  issue_type text not null,
  reason text not null,
  status text not null default 'open',
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table public.recipient_outreach_ownership (
  normalized_email text primary key,
  owner_lead_id uuid,
  state text not null default 'active',
  claimed_at timestamptz not null default now(),
  metadata jsonb not null default '{}'
);

create table public.deals (
  id uuid primary key,
  lead_id uuid,
  deal_value numeric(10,2) not null,
  deal_type text not null,
  notes text,
  closed_at timestamptz not null default now()
);

-- Sensitive canary table that the snapshot query must never touch.
create table public.ai_provider_credentials (
  id uuid primary key,
  provider text not null,
  api_key text not null
);

-- ── Reference data ──────────────────────────────────────────────────────────

insert into public.categories (id, name) values
  ('00000000-0000-4000-8000-00000000c001', 'Restaurants'),
  ('00000000-0000-4000-8000-00000000c002', 'Cafes'),
  ('00000000-0000-4000-8000-00000000c003', 'Gyms');

insert into public.category_email_templates (id, category_id, template_type, subject_template, body_template) values
  -- Valid: only allow-listed placeholders, single-line subject.
  ('00000000-0000-4000-8000-00000000b001', '00000000-0000-4000-8000-00000000c001', 'initial_pitch',
   'Quick collab idea for {{business_name}}',
   'Hi there, I film {{category_name}} content around {{city}}. Worth a chat?'),
  -- Valid but demands a website, which one seeded lead does not have.
  ('00000000-0000-4000-8000-00000000b002', '00000000-0000-4000-8000-00000000c002', 'initial_pitch',
   'Content for {{business_name}}',
   'Saw {{website}} and thought of a collab.'),
  -- Invalid: unsupported placeholder makes the template unusable.
  ('00000000-0000-4000-8000-00000000b003', '00000000-0000-4000-8000-00000000c003', 'initial_pitch',
   'Hello {{business_name}}',
   'Your {{owner_first_name}} mentioned you film content.');

insert into public.settings (id, key, value) values
  ('00000000-0000-4000-8000-000000005b01', 'initial_email_mode', 'ai_personalised'),
  ('00000000-0000-4000-8000-000000005b02', 'reactivation_enabled', 'true'),
  ('00000000-0000-4000-8000-000000005b03', 'follow_up_1_days', '7'),
  ('00000000-0000-4000-8000-000000005b04', 'follow_up_2_days', '14'),
  ('00000000-0000-4000-8000-000000005b05', 'follow_up_3_days', '21'),
  ('00000000-0000-4000-8000-000000005b06', 'dead_lead_days', '21'),
  ('00000000-0000-4000-8000-000000005b07', 'reactivation_delay_days', '60'),
  ('00000000-0000-4000-8000-000000005b08', 'dead_after_reactivation_days', '14'),
  ('00000000-0000-4000-8000-000000005b09', 'resend_api_key_label', 're_live_fixture_secret_value');

insert into public.ai_provider_credentials (id, provider, api_key) values
  ('00000000-0000-4000-8000-00000000fc01', 'anthropic', 'sk-ant-fixture-secret-0123456789');

-- ── Designed leads ──────────────────────────────────────────────────────────
-- Every row carries sensitive source values on purpose.

insert into public.leads (
  id, business_name, category_id, category_name, address, city, phone, email, website,
  status, source, notes, reactivation_sent_at, updated_at, delivery_suppressed_emails,
  normalized_email, outreach_suppression_reason, outreach_suppressed_at
) values
  ('00000000-0000-4000-8000-000000000001', 'Bondi Spice House', '00000000-0000-4000-8000-00000000c001', 'Restaurants', '12 Campbell Pde', 'Bondi Beach', '+61 2 9130 1111', null, 'https://bondispice.com.au', 'new', 'finder', 'no contact yet', null, now(), '{}', null, null, null),
  ('00000000-0000-4000-8000-000000000002', 'Manly Grill Co', '00000000-0000-4000-8000-00000000c001', 'Restaurants', '3 The Corso', 'Manly', '+61 2 9977 2222', 'hello@manlygrill.com.au', 'https://manlygrill.com.au', 'new', 'finder', null, null, now(), '{}', 'hello@manlygrill.com.au', null, null),
  ('00000000-0000-4000-8000-000000000003', 'Surry Hills Pasta', '00000000-0000-4000-8000-00000000c001', 'Restaurants', '88 Crown St', 'Surry Hills', '+61 2 9212 3333', 'book@surryhillspasta.com.au', 'https://surryhillspasta.com.au', 'researched', 'finder', null, null, now(), '{}', 'book@surryhillspasta.com.au', null, null),
  ('00000000-0000-4000-8000-000000000004', 'Newtown Noodle Bar', '00000000-0000-4000-8000-00000000c001', 'Restaurants', '201 King St', 'Newtown', '+61 2 9550 4444', 'eat@newtownnoodle.com.au', 'https://newtownnoodle.com.au', 'email_ready', 'finder', null, null, now(), '{}', 'eat@newtownnoodle.com.au', null, null),
  ('00000000-0000-4000-8000-000000000005', 'Glebe Dumpling Den', '00000000-0000-4000-8000-00000000c001', 'Restaurants', '40 Glebe Point Rd', 'Glebe', '+61 2 9660 5555', 'info@glebedumpling.com.au', 'https://glebedumpling.com.au', 'email_ready', 'finder', null, null, now(), '{}', 'info@glebedumpling.com.au', null, null),
  ('00000000-0000-4000-8000-000000000006', 'Coogee Poke Bowl', '00000000-0000-4000-8000-00000000c001', 'Restaurants', '9 Arden St', 'Coogee', '+61 2 9665 6666', 'hi@coogeepoke.com.au', 'https://coogeepoke.com.au', 'contacted', 'finder', null, null, now(), '{}', 'hi@coogeepoke.com.au', null, null),
  ('00000000-0000-4000-8000-000000000007', 'Redfern Roti Room', '00000000-0000-4000-8000-00000000c001', 'Restaurants', '14 Redfern St', 'Redfern', '+61 2 9698 7777', 'orders@redfernroti.com.au', 'https://redfernroti.com.au', 'contacted', 'finder', null, null, now(), '{}', 'orders@redfernroti.com.au', null, null),
  ('00000000-0000-4000-8000-000000000008', 'Paddington Pide', '00000000-0000-4000-8000-00000000c001', 'Restaurants', '7 Oxford St', 'Paddington', '+61 2 9331 8888', 'team@paddingtonpide.com.au', 'https://paddingtonpide.com.au', 'contacted', 'finder', null, null, now(), '{}', 'team@paddingtonpide.com.au', null, null),
  ('00000000-0000-4000-8000-000000000009', 'Marrickville Mezze', '00000000-0000-4000-8000-00000000c001', 'Restaurants', '250 Illawarra Rd', 'Marrickville', '+61 2 9569 9999', 'hello@marrickvillemezze.com.au', 'https://marrickvillemezze.com.au', 'contacted', 'finder', null, null, now(), '{}', 'hello@marrickvillemezze.com.au', null, null),
  ('00000000-0000-4000-8000-000000000010', 'Chatswood Charcoal', '00000000-0000-4000-8000-00000000c001', 'Restaurants', '1 Victoria Ave', 'Chatswood', '+61 2 9411 1010', 'grill@chatswoodcharcoal.com.au', 'https://chatswoodcharcoal.com.au', 'contacted', 'finder', null, null, now(), '{}', 'grill@chatswoodcharcoal.com.au', null, null),
  ('00000000-0000-4000-8000-000000000011', 'Parramatta Pilaf', '00000000-0000-4000-8000-00000000c001', 'Restaurants', '5 Church St', 'Parramatta', '+61 2 9635 1111', 'rice@parramattapilaf.com.au', 'https://parramattapilaf.com.au', 'contacted', 'finder', null, now() - interval '15 days', now(), '{}', 'rice@parramattapilaf.com.au', null, null),
  ('00000000-0000-4000-8000-000000000012', 'Burwood Biryani', '00000000-0000-4000-8000-00000000c001', 'Restaurants', '22 Burwood Rd', 'Burwood', '+61 2 9744 1212', 'chef@burwoodbiryani.com.au', 'https://burwoodbiryani.com.au', 'contacted', 'finder', null, now() - interval '5 days', now(), '{}', 'chef@burwoodbiryani.com.au', null, null),
  ('00000000-0000-4000-8000-000000000013', 'Cronulla Crepes', '00000000-0000-4000-8000-00000000c002', 'Cafes', '18 Cronulla St', 'Cronulla', '+61 2 9523 1313', 'hello@cronullacrepes.com.au', 'https://cronullacrepes.com.au', 'replied', 'finder', null, null, now(), '{}', 'hello@cronullacrepes.com.au', null, null),
  ('00000000-0000-4000-8000-000000000014', 'Balmain Brew Lab', '00000000-0000-4000-8000-00000000c002', 'Cafes', '300 Darling St', 'Balmain', '+61 2 9810 1414', 'hey@balmainbrew.com.au', 'https://balmainbrew.com.au', 'interested', 'finder', null, null, now(), '{}', 'hey@balmainbrew.com.au', null, null),
  ('00000000-0000-4000-8000-000000000015', 'Randwick Roasters', '00000000-0000-4000-8000-00000000c002', 'Cafes', '60 Belmore Rd', 'Randwick', '+61 2 9399 1515', 'sales@randwickroasters.com.au', 'https://randwickroasters.com.au', 'negotiating', 'finder', null, null, now(), '{}', 'sales@randwickroasters.com.au', null, null),
  ('00000000-0000-4000-8000-000000000016', 'Mosman Matcha', '00000000-0000-4000-8000-00000000c002', 'Cafes', '2 Military Rd', 'Mosman', '+61 2 9969 1616', 'hello@mosmanmatcha.com.au', 'https://mosmanmatcha.com.au', 'closed', 'finder', null, null, now(), '{}', 'hello@mosmanmatcha.com.au', null, null),
  ('00000000-0000-4000-8000-000000000017', 'Leichhardt Latte', '00000000-0000-4000-8000-00000000c002', 'Cafes', '111 Norton St', 'Leichhardt', '+61 2 9569 1717', 'ciao@leichhardtlatte.com.au', 'https://leichhardtlatte.com.au', 'closed_manual', 'manual', null, null, now(), '{}', 'ciao@leichhardtlatte.com.au', null, null),
  ('00000000-0000-4000-8000-000000000018', 'Hurstville Hotpot', '00000000-0000-4000-8000-00000000c001', 'Restaurants', '8 Forest Rd', 'Hurstville', '+61 2 9580 1818', 'info@hurstvillehotpot.com.au', 'https://hurstvillehotpot.com.au', 'dead', 'finder', null, null, now(), '{}', 'info@hurstvillehotpot.com.au', null, null),
  ('00000000-0000-4000-8000-000000000019', 'Bankstown Baklava', '00000000-0000-4000-8000-00000000c001', 'Restaurants', '30 Restwell St', 'Bankstown', '+61 2 9790 1919', 'sweet@bankstownbaklava.com.au', 'https://bankstownbaklava.com.au', 'contacted', 'finder', null, null, now(), '{}', 'sweet@bankstownbaklava.com.au', 'operator opted the recipient out', now() - interval '3 days'),
  ('00000000-0000-4000-8000-000000000020', 'Ashfield Arepas', '00000000-0000-4000-8000-00000000c001', 'Restaurants', '5 Liverpool Rd', 'Ashfield', '+61 2 9798 2020', 'hola@ashfieldarepas.com.au', 'https://ashfieldarepas.com.au', 'email_ready', 'finder', null, null, now(), '{}', 'hola@ashfieldarepas.com.au', null, null),
  ('00000000-0000-4000-8000-000000000021', 'Strathfield Shawarma', '00000000-0000-4000-8000-00000000c001', 'Restaurants', '17 The Boulevarde', 'Strathfield', '+61 2 9746 2121', 'shared@grouprestaurants.com.au', 'https://strathfieldshawarma.com.au', 'researched', 'finder', null, null, now(), '{}', 'shared@grouprestaurants.com.au', null, null),
  ('00000000-0000-4000-8000-000000000022', 'Penrith Pizzeria', null, 'Uncategorised', '40 High St', 'Penrith', '+61 2 4721 2222', 'oven@penrithpizzeria.com.au', 'https://penrithpizzeria.com.au', 'researched', 'finder', null, null, now(), '{}', 'oven@penrithpizzeria.com.au', null, null),
  ('00000000-0000-4000-8000-000000000023', 'Wollongong Wraps', '00000000-0000-4000-8000-00000000c001', 'Restaurants', '90 Crown St', 'Wollongong', '+61 2 4228 2323', 'hi@wollongongwraps.com.au', 'https://wollongongwraps.com.au', 'new', 'manual', 'added by operator', null, now(), '{}', 'hi@wollongongwraps.com.au', null, null),
  ('00000000-0000-4000-8000-000000000024', 'Gosford Gozleme', '00000000-0000-4000-8000-00000000c001', 'Restaurants', '150 Mann St', 'Gosford', '+61 2 4325 2424', 'eat@gosfordgozleme.com.au', 'https://gosfordgozleme.com.au', 'contacted', 'finder', null, null, now(), '{}', 'eat@gosfordgozleme.com.au', null, null),
  ('00000000-0000-4000-8000-000000000025', 'Katoomba Kebabs', '00000000-0000-4000-8000-00000000c001', 'Restaurants', '20 Katoomba St', 'Katoomba', '+61 2 4782 2525', 'order@katoombakebabs.com.au', 'https://katoombakebabs.com.au', 'contacted', 'finder', null, null, now(), '{}', 'order@katoombakebabs.com.au', null, null),
  ('00000000-0000-4000-8000-000000000026', 'Dee Why Donburi', '00000000-0000-4000-8000-00000000c002', 'Cafes', '1 Pittwater Rd', 'Dee Why', '+61 2 9971 2626', 'hello@deewhydonburi.com.au', null, 'researched', 'finder', null, null, now(), '{}', 'hello@deewhydonburi.com.au', null, null),
  ('00000000-0000-4000-8000-000000000027', 'Kogarah Kimchi', '00000000-0000-4000-8000-00000000c003', 'Gyms', '11 Railway Pde', 'Kogarah', '+61 2 9587 2727', 'hi@kogarahkimchi.com.au', 'https://kogarahkimchi.com.au', 'researched', 'finder', null, null, now(), '{}', 'hi@kogarahkimchi.com.au', null, null),
  ('00000000-0000-4000-8000-000000000028', 'Epping Empanadas', '00000000-0000-4000-8000-00000000c001', 'Restaurants', '25 Rawson St', 'Epping', '+61 2 9876 2828', 'hola@eppingempanadas.com.au', 'https://eppingempanadas.com.au', 'contacted', 'finder', null, null, now(), '{bounced@eppingempanadas.com.au,hola@eppingempanadas.com.au}', 'hola@eppingempanadas.com.au', null, null),
  ('00000000-0000-4000-8000-000000000029', 'Rozelle Ramen', '00000000-0000-4000-8000-00000000c001', 'Restaurants', '600 Darling St', 'Rozelle', '+61 2 9810 2929', 'slurp@rozelleramen.com.au', 'https://rozelleramen.com.au', 'contacted', 'finder', null, null, now(), '{}', 'slurp@rozelleramen.com.au', null, null),
  ('00000000-0000-4000-8000-000000000030', 'Lane Cove Laksa', '00000000-0000-4000-8000-00000000c001', 'Restaurants', '70 Longueville Rd', 'Lane Cove', '+61 2 9427 3030', null, 'https://lanecovelaksa.com.au', 'researched', 'finder', null, null, now(), '{}', null, null, null);

-- Lead 2 and lead 27 are pinned to template mode by activity snapshots.
insert into public.activity_log (id, event_type, lead_id, description, metadata, created_at) values
  ('00000000-0000-4000-8000-00000000a001', 'initial_email_mode_snapshot', '00000000-0000-4000-8000-000000000002', 'mode pinned', '{"initial_email_mode":"template","operator_email":"ops@aussieventure.com.au"}', now() - interval '2 days'),
  ('00000000-0000-4000-8000-00000000a002', 'initial_email_mode_snapshot', '00000000-0000-4000-8000-000000000026', 'mode pinned', '{"initial_email_mode":"template","operator_email":"ops@aussieventure.com.au"}', now() - interval '2 days'),
  ('00000000-0000-4000-8000-00000000a003', 'initial_email_mode_snapshot', '00000000-0000-4000-8000-000000000027', 'mode pinned', '{"initial_email_mode":"template","operator_email":"ops@aussieventure.com.au"}', now() - interval '2 days'),
  ('00000000-0000-4000-8000-00000000a004', 'initial_email_mode_snapshot', '00000000-0000-4000-8000-000000000022', 'mode pinned', '{"initial_email_mode":"template","operator_email":"ops@aussieventure.com.au"}', now() - interval '2 days'),
  ('00000000-0000-4000-8000-00000000a005', 'initial_email_mode_snapshot', '00000000-0000-4000-8000-000000000002', 'superseded older snapshot', '{"initial_email_mode":"ai_personalised"}', now() - interval '9 days');

insert into public.emails (id, lead_id, type, subject, body_html, body_text, status, sent_at, replied_at, created_at, message_id) values
  -- 4: email_ready with a pending initial pitch -> SEND_INITIAL
  ('00000000-0000-4000-8000-00000000e004', '00000000-0000-4000-8000-000000000004', 'initial_pitch', 'Collab idea for Newtown Noodle Bar', '<p>secret body</p>', 'secret body', 'pending_send', null, null, now() - interval '1 day', null),
  -- 5: email_ready with an uncertain initial send -> MANUAL_REVIEW
  ('00000000-0000-4000-8000-00000000e005', '00000000-0000-4000-8000-000000000005', 'initial_pitch', 'Collab idea for Glebe Dumpling Den', '<p>secret body</p>', 'secret body', 'email_sync_failed', null, null, now() - interval '2 days', 'msg-fixture-0005@hostinger'),
  -- 6: contacted, FU1 not yet due
  ('00000000-0000-4000-8000-00000000e006', '00000000-0000-4000-8000-000000000006', 'initial_pitch', 'Collab idea for Coogee Poke Bowl', '<p>secret body</p>', 'secret body', 'sent', now() - interval '3 days', null, now() - interval '3 days', 'msg-fixture-0006@hostinger'),
  -- 7: FU1 due
  ('00000000-0000-4000-8000-00000000e007', '00000000-0000-4000-8000-000000000007', 'initial_pitch', 'Collab idea for Redfern Roti Room', '<p>secret body</p>', 'secret body', 'sent', now() - interval '8 days', null, now() - interval '8 days', 'msg-fixture-0007@hostinger'),
  -- 8: FU2 due
  ('00000000-0000-4000-8000-00000000e008', '00000000-0000-4000-8000-000000000008', 'initial_pitch', 'Collab idea for Paddington Pide', '<p>secret body</p>', 'secret body', 'sent', now() - interval '15 days', null, now() - interval '15 days', 'msg-fixture-0008@hostinger'),
  ('00000000-0000-4000-8000-00000000e108', '00000000-0000-4000-8000-000000000008', 'follow_up_1', 'Following up', '<p>secret body</p>', 'secret body', 'sent', now() - interval '8 days', null, now() - interval '8 days', 'msg-fixture-0108@hostinger'),
  -- 9: FU3 due
  ('00000000-0000-4000-8000-00000000e009', '00000000-0000-4000-8000-000000000009', 'initial_pitch', 'Collab idea for Marrickville Mezze', '<p>secret body</p>', 'secret body', 'sent', now() - interval '22 days', null, now() - interval '22 days', 'msg-fixture-0009@hostinger'),
  ('00000000-0000-4000-8000-00000000e109', '00000000-0000-4000-8000-000000000009', 'follow_up_1', 'Following up', '<p>secret body</p>', 'secret body', 'sent', now() - interval '15 days', null, now() - interval '15 days', 'msg-fixture-0109@hostinger'),
  ('00000000-0000-4000-8000-00000000e209', '00000000-0000-4000-8000-000000000009', 'follow_up_2', 'Following up again', '<p>secret body</p>', 'secret body', 'sent', now() - interval '8 days', null, now() - interval '8 days', 'msg-fixture-0209@hostinger'),
  -- 10: reactivation due (61 days from initial send)
  ('00000000-0000-4000-8000-00000000e010', '00000000-0000-4000-8000-000000000010', 'initial_pitch', 'Collab idea for Chatswood Charcoal', '<p>secret body</p>', 'secret body', 'sent', now() - interval '61 days', null, now() - interval '61 days', 'msg-fixture-0010@hostinger'),
  ('00000000-0000-4000-8000-00000000e110', '00000000-0000-4000-8000-000000000010', 'follow_up_1', 'Following up', '<p>secret body</p>', 'secret body', 'sent', now() - interval '54 days', null, now() - interval '54 days', 'msg-fixture-0110@hostinger'),
  ('00000000-0000-4000-8000-00000000e210', '00000000-0000-4000-8000-000000000010', 'follow_up_2', 'Following up again', '<p>secret body</p>', 'secret body', 'sent', now() - interval '47 days', null, now() - interval '47 days', 'msg-fixture-0210@hostinger'),
  ('00000000-0000-4000-8000-00000000e310', '00000000-0000-4000-8000-000000000010', 'follow_up_3', 'Last note', '<p>secret body</p>', 'secret body', 'sent', now() - interval '40 days', null, now() - interval '40 days', 'msg-fixture-0310@hostinger'),
  -- 11: reactivated 15 days ago -> MARK_DEAD
  ('00000000-0000-4000-8000-00000000e011', '00000000-0000-4000-8000-000000000011', 'initial_pitch', 'Collab idea for Parramatta Pilaf', '<p>secret body</p>', 'secret body', 'sent', now() - interval '85 days', null, now() - interval '85 days', 'msg-fixture-0011@hostinger'),
  ('00000000-0000-4000-8000-00000000e111', '00000000-0000-4000-8000-000000000011', 'follow_up_1', 'Following up', '<p>secret body</p>', 'secret body', 'sent', now() - interval '78 days', null, now() - interval '78 days', 'msg-fixture-0111@hostinger'),
  ('00000000-0000-4000-8000-00000000e211', '00000000-0000-4000-8000-000000000011', 'follow_up_2', 'Following up again', '<p>secret body</p>', 'secret body', 'sent', now() - interval '71 days', null, now() - interval '71 days', 'msg-fixture-0211@hostinger'),
  ('00000000-0000-4000-8000-00000000e311', '00000000-0000-4000-8000-000000000011', 'follow_up_3', 'Last note', '<p>secret body</p>', 'secret body', 'sent', now() - interval '64 days', null, now() - interval '64 days', 'msg-fixture-0311@hostinger'),
  ('00000000-0000-4000-8000-00000000e411', '00000000-0000-4000-8000-000000000011', 'reactivation', 'Circling back', '<p>secret body</p>', 'secret body', 'sent', now() - interval '15 days', null, now() - interval '15 days', 'msg-fixture-0411@hostinger'),
  -- 12: reactivated 5 days ago -> WAIT
  ('00000000-0000-4000-8000-00000000e012', '00000000-0000-4000-8000-000000000012', 'initial_pitch', 'Collab idea for Burwood Biryani', '<p>secret body</p>', 'secret body', 'sent', now() - interval '75 days', null, now() - interval '75 days', 'msg-fixture-0012@hostinger'),
  ('00000000-0000-4000-8000-00000000e112', '00000000-0000-4000-8000-000000000012', 'follow_up_1', 'Following up', '<p>secret body</p>', 'secret body', 'sent', now() - interval '68 days', null, now() - interval '68 days', 'msg-fixture-0112@hostinger'),
  ('00000000-0000-4000-8000-00000000e212', '00000000-0000-4000-8000-000000000012', 'follow_up_2', 'Following up again', '<p>secret body</p>', 'secret body', 'sent', now() - interval '61 days', null, now() - interval '61 days', 'msg-fixture-0212@hostinger'),
  ('00000000-0000-4000-8000-00000000e312', '00000000-0000-4000-8000-000000000012', 'follow_up_3', 'Last note', '<p>secret body</p>', 'secret body', 'sent', now() - interval '54 days', null, now() - interval '54 days', 'msg-fixture-0312@hostinger'),
  ('00000000-0000-4000-8000-00000000e412', '00000000-0000-4000-8000-000000000012', 'reactivation', 'Circling back', '<p>secret body</p>', 'secret body', 'sent', now() - interval '5 days', null, now() - interval '5 days', 'msg-fixture-0412@hostinger'),
  -- 13: replied
  ('00000000-0000-4000-8000-00000000e013', '00000000-0000-4000-8000-000000000013', 'initial_pitch', 'Collab idea for Cronulla Crepes', '<p>secret body</p>', 'secret body', 'sent', now() - interval '9 days', now() - interval '6 days', now() - interval '9 days', 'msg-fixture-0013@hostinger'),
  -- 14/15/16/17/18 have a delivered initial pitch behind their later status
  ('00000000-0000-4000-8000-00000000e014', '00000000-0000-4000-8000-000000000014', 'initial_pitch', 'Collab idea for Balmain Brew Lab', '<p>secret body</p>', 'secret body', 'sent', now() - interval '30 days', now() - interval '27 days', now() - interval '30 days', 'msg-fixture-0014@hostinger'),
  ('00000000-0000-4000-8000-00000000e015', '00000000-0000-4000-8000-000000000015', 'initial_pitch', 'Collab idea for Randwick Roasters', '<p>secret body</p>', 'secret body', 'sent', now() - interval '45 days', now() - interval '40 days', now() - interval '45 days', 'msg-fixture-0015@hostinger'),
  ('00000000-0000-4000-8000-00000000e016', '00000000-0000-4000-8000-000000000016', 'initial_pitch', 'Collab idea for Mosman Matcha', '<p>secret body</p>', 'secret body', 'sent', now() - interval '90 days', now() - interval '85 days', now() - interval '90 days', 'msg-fixture-0016@hostinger'),
  ('00000000-0000-4000-8000-00000000e018', '00000000-0000-4000-8000-000000000018', 'initial_pitch', 'Collab idea for Hurstville Hotpot', '<p>secret body</p>', 'secret body', 'sent', now() - interval '120 days', null, now() - interval '120 days', 'msg-fixture-0018@hostinger'),
  -- 19: suppressed lead that would otherwise be FU1-eligible
  ('00000000-0000-4000-8000-00000000e019', '00000000-0000-4000-8000-000000000019', 'initial_pitch', 'Collab idea for Bankstown Baklava', '<p>secret body</p>', 'secret body', 'sent', now() - interval '30 days', null, now() - interval '30 days', 'msg-fixture-0019@hostinger'),
  -- 20: open duplicate flag with a pending initial pitch
  ('00000000-0000-4000-8000-00000000e020', '00000000-0000-4000-8000-000000000020', 'initial_pitch', 'Collab idea for Ashfield Arepas', '<p>secret body</p>', 'secret body', 'pending_send', null, null, now() - interval '1 day', null),
  -- 24: FU1 send uncertainty
  ('00000000-0000-4000-8000-00000000e024', '00000000-0000-4000-8000-000000000024', 'initial_pitch', 'Collab idea for Gosford Gozleme', '<p>secret body</p>', 'secret body', 'sent', now() - interval '11 days', null, now() - interval '11 days', 'msg-fixture-0024@hostinger'),
  ('00000000-0000-4000-8000-00000000e124', '00000000-0000-4000-8000-000000000024', 'follow_up_1', 'Following up', '<p>secret body</p>', 'secret body', 'email_sync_failed', null, null, now() - interval '4 days', 'msg-fixture-0124@hostinger'),
  -- 25: FU3 delivered without FU1/FU2 (broken legacy sequence)
  ('00000000-0000-4000-8000-00000000e025', '00000000-0000-4000-8000-000000000025', 'initial_pitch', 'Collab idea for Katoomba Kebabs', '<p>secret body</p>', 'secret body', 'sent', now() - interval '95 days', null, now() - interval '95 days', 'msg-fixture-0025@hostinger'),
  ('00000000-0000-4000-8000-00000000e325', '00000000-0000-4000-8000-000000000025', 'follow_up_3', 'Last note', '<p>secret body</p>', 'secret body', 'sent', now() - interval '60 days', null, now() - interval '60 days', 'msg-fixture-0325@hostinger'),
  -- 28: delivery-suppressed recipient, otherwise FU1-eligible
  ('00000000-0000-4000-8000-00000000e028', '00000000-0000-4000-8000-000000000028', 'initial_pitch', 'Collab idea for Epping Empanadas', '<p>secret body</p>', 'secret body', 'sent', now() - interval '20 days', null, now() - interval '20 days', 'msg-fixture-0028@hostinger'),
  -- 29: contacted with no initial-pitch row at all -> MANUAL_REVIEW
  ('00000000-0000-4000-8000-00000000e129', '00000000-0000-4000-8000-000000000029', 'follow_up_1', 'Following up', '<p>secret body</p>', 'secret body', 'pending_send', null, null, now() - interval '1 day', null);

insert into public.lead_data_quality_flags (id, lead_id, normalized_email, issue_type, reason, status) values
  ('00000000-0000-4000-8000-00000000f001', '00000000-0000-4000-8000-000000000020', 'hola@ashfieldarepas.com.au', 'duplicate_lead', 'matches an existing lead', 'open'),
  ('00000000-0000-4000-8000-00000000f002', '00000000-0000-4000-8000-000000000003', 'book@surryhillspasta.com.au', 'duplicate_lead', 'resolved earlier', 'resolved'),
  ('00000000-0000-4000-8000-00000000f003', '00000000-0000-4000-8000-000000000021', 'shared@grouprestaurants.com.au', 'shared_email', 'shared inbox', 'open');

-- Lead 21 shares a recipient owned by a different lead.
insert into public.recipient_outreach_ownership (normalized_email, owner_lead_id, state) values
  ('shared@grouprestaurants.com.au', '00000000-0000-4000-8000-000000000099', 'active'),
  ('hi@coogeepoke.com.au', '00000000-0000-4000-8000-000000000006', 'active');

insert into public.deals (id, lead_id, deal_value, deal_type, notes) values
  ('00000000-0000-4000-8000-00000000d001', '00000000-0000-4000-8000-000000000016', 1500.00, 'visit_content', 'paid in full');

-- ── Volume filler ───────────────────────────────────────────────────────────
-- Pushes the population past the 100-row hard cap so the representative
-- sampler has to prioritise cohorts over raw volume.

insert into public.leads (
  id, business_name, category_id, category_name, address, city, phone, email, website,
  status, source, updated_at, normalized_email
)
select
  ('00000000-0000-4000-8000-0000000f' || lpad(n::text, 4, '0'))::uuid,
  'Filler Venue ' || n,
  '00000000-0000-4000-8000-00000000c001',
  'Restaurants',
  n || ' Filler St',
  'Sydney',
  '+61 2 9000 ' || lpad(n::text, 4, '0'),
  'filler' || n || '@fillervenues.com.au',
  'https://filler' || n || '.com.au',
  (array['new', 'researched', 'contacted', 'dead'])[1 + (n % 4)],
  'finder',
  now() - (n || ' hours')::interval,
  'filler' || n || '@fillervenues.com.au'
from generate_series(1, 150) as n;

insert into public.emails (id, lead_id, type, subject, body_html, body_text, status, sent_at, created_at)
select
  ('00000000-0000-4000-8000-0000010f' || lpad(n::text, 4, '0'))::uuid,
  ('00000000-0000-4000-8000-0000000f' || lpad(n::text, 4, '0'))::uuid,
  'initial_pitch',
  'Filler pitch ' || n,
  '<p>secret body</p>',
  'secret body',
  'sent',
  now() - ((10 + (n % 40)) || ' days')::interval,
  now() - ((10 + (n % 40)) || ' days')::interval
from generate_series(1, 150) as n
where (array['new', 'researched', 'contacted', 'dead'])[1 + (n % 4)] in ('contacted', 'dead');

analyze;
