with
audit_clock as (
  select statement_timestamp() as as_of
),
approved_settings as (
  select
    coalesce(max(value) filter (where key = 'initial_email_mode'), 'ai_personalised') as initial_email_mode,
    coalesce(max(value) filter (where key = 'reactivation_enabled'), 'false') = 'true' as reactivation_enabled,
    coalesce(max(value) filter (where key = 'follow_up_1_days' and value ~ '^[0-9]+$')::integer, 7) as follow_up_1_days,
    coalesce(max(value) filter (where key = 'follow_up_2_days' and value ~ '^[0-9]+$')::integer, 14) as follow_up_2_days,
    coalesce(max(value) filter (where key = 'follow_up_3_days' and value ~ '^[0-9]+$')::integer, 21) as follow_up_3_days,
    coalesce(max(value) filter (where key = 'dead_lead_days' and value ~ '^[0-9]+$')::integer, 21) as dead_lead_days,
    coalesce(max(value) filter (where key = 'reactivation_delay_days' and value ~ '^[0-9]+$')::integer, 60) as reactivation_delay_days,
    coalesce(max(value) filter (where key = 'dead_after_reactivation_days' and value ~ '^[0-9]+$')::integer, 14) as dead_after_reactivation_days
  from public.settings
  where key in (
    'initial_email_mode', 'reactivation_enabled', 'follow_up_1_days',
    'follow_up_2_days', 'follow_up_3_days', 'dead_lead_days',
    'reactivation_delay_days', 'dead_after_reactivation_days'
  )
),
mode_snapshots as (
  select distinct on (lead_id)
    lead_id,
    metadata ->> 'initial_email_mode' as initial_email_mode
  from public.activity_log
  where event_type = 'initial_email_mode_snapshot'
    and metadata ->> 'initial_email_mode' in ('template', 'ai_personalised')
  order by lead_id, created_at desc, id desc
),
email_facts as (
  select
    lead_id,
    min(sent_at) filter (where type = 'initial_pitch' and sent_at is not null) as initial_sent_at,
    bool_or(type = 'initial_pitch' and status = 'email_sync_failed' and sent_at is null) as initial_uncertain,
    bool_or(type = 'initial_pitch' and status = 'pending_send' and sent_at is null) as initial_pending,
    min(sent_at) filter (where type = 'follow_up_1' and sent_at is not null) as follow_up_1_sent_at,
    bool_or(type = 'follow_up_1' and status = 'email_sync_failed' and sent_at is null) as follow_up_1_uncertain,
    bool_or(type = 'follow_up_1' and status = 'pending_send' and sent_at is null) as follow_up_1_pending,
    min(sent_at) filter (where type = 'follow_up_2' and sent_at is not null) as follow_up_2_sent_at,
    bool_or(type = 'follow_up_2' and status = 'email_sync_failed' and sent_at is null) as follow_up_2_uncertain,
    bool_or(type = 'follow_up_2' and status = 'pending_send' and sent_at is null) as follow_up_2_pending,
    min(sent_at) filter (where type = 'follow_up_3' and sent_at is not null) as follow_up_3_sent_at,
    bool_or(type = 'follow_up_3' and status = 'email_sync_failed' and sent_at is null) as follow_up_3_uncertain,
    bool_or(type = 'follow_up_3' and status = 'pending_send' and sent_at is null) as follow_up_3_pending,
    min(sent_at) filter (where type = 'reactivation' and sent_at is not null) as reactivation_email_sent_at,
    bool_or(replied_at is not null) as reply_received
  from public.emails
  where type in ('initial_pitch', 'follow_up_1', 'follow_up_2', 'follow_up_3', 'reactivation')
    and status in ('pending_send', 'sent', 'email_sync_failed')
  group by lead_id
),
duplicate_leads as (
  select distinct lead_id
  from public.lead_data_quality_flags
  where status = 'open' and issue_type = 'duplicate_lead'
),
deal_leads as (
  select distinct lead_id from public.deals where lead_id is not null
),
template_facts as (
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
        where found[1] <> all(array['business_name', 'contact_name', 'category_name', 'city', 'website'])
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
  where t.template_type = 'initial_pitch'
),
facts as (
  select
    l.id as lead_id,
    l.status,
    l.category_id,
    l.source = 'manual' as manual_source,
    l.category_id is not null as category_id_present,
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
    d.lead_id is not null as duplicate,
    case
      when l.normalized_email is null then 'unclaimed'
      when o.normalized_email is null then 'unclaimed'
      when o.owner_lead_id = l.id then 'owned_by_lead'
      else 'owned_by_other'
    end as recipient_ownership,
    case when dl.lead_id is not null or l.status in ('closed', 'closed_manual') then 'closed' else 'none' end as deal_state,
    coalesce(ms.initial_email_mode, s.initial_email_mode, 'ai_personalised') as initial_email_mode,
    nullif(btrim(l.email), '') is not null or l.status <> 'new' as contact_discovery_complete,
    l.status <> 'new' as personalisation_complete,
    false as can_supply_template_fields,
    coalesce(tf.template_ready, false) as template_available,
    coalesce(tf.required_placeholders, array[]::text[]) as required_template_placeholders,
    coalesce(tf.template_ready, false) and not exists (
      select 1 from unnest(coalesce(tf.required_placeholders, array[]::text[])) required(name)
      where case required.name
        when 'business_name' then nullif(btrim(l.business_name), '') is null
        when 'contact_name' then true
        when 'category_name' then nullif(btrim(l.category_name), '') is null
        when 'city' then nullif(btrim(l.city), '') is null
        when 'website' then nullif(btrim(l.website), '') is null
        else true
      end
    ) as required_template_data_available,
    case
      when ef.initial_sent_at is not null then 'sent'
      when coalesce(ef.initial_uncertain, false) then 'uncertain'
      when coalesce(ef.initial_pending, false) then 'pending'
      else 'missing'
    end as initial_email_state,
    ef.initial_sent_at,
    case
      when ef.follow_up_1_sent_at is not null then 'sent'
      when coalesce(ef.follow_up_1_uncertain, false) then 'uncertain'
      when coalesce(ef.follow_up_1_pending, false) then 'pending'
      else 'missing'
    end as follow_up_1_state,
    ef.follow_up_1_sent_at,
    case
      when ef.follow_up_2_sent_at is not null then 'sent'
      when coalesce(ef.follow_up_2_uncertain, false) then 'uncertain'
      when coalesce(ef.follow_up_2_pending, false) then 'pending'
      else 'missing'
    end as follow_up_2_state,
    ef.follow_up_2_sent_at,
    case
      when ef.follow_up_3_sent_at is not null then 'sent'
      when coalesce(ef.follow_up_3_uncertain, false) then 'uncertain'
      when coalesce(ef.follow_up_3_pending, false) then 'pending'
      else 'missing'
    end as follow_up_3_state,
    ef.follow_up_3_sent_at,
    coalesce(ef.reply_received, false) or l.status = 'replied' as reply_received,
    null::text as reply_classification,
    s.reactivation_enabled,
    coalesce(l.reactivation_sent_at, ef.reactivation_email_sent_at) as reactivation_sent_at,
    s.follow_up_1_days,
    s.follow_up_2_days,
    s.follow_up_3_days,
    s.dead_lead_days,
    s.reactivation_delay_days,
    s.dead_after_reactivation_days,
    c.as_of
  from public.leads l
  cross join approved_settings s
  cross join audit_clock c
  left join email_facts ef on ef.lead_id = l.id
  left join mode_snapshots ms on ms.lead_id = l.id
  left join duplicate_leads d on d.lead_id = l.id
  left join public.recipient_outreach_ownership o on o.normalized_email = l.normalized_email
  left join deal_leads dl on dl.lead_id = l.id
  left join template_facts tf on tf.category_id = l.category_id
  where l.status in (
    'new', 'researched', 'email_ready', 'contacted', 'replied',
    'interested', 'negotiating', 'closed', 'closed_manual', 'dead'
  )
),
labeled as (
  select
    f.*,
    array_remove(array[
      case when suppressed then 'suppression' end,
      case when duplicate or recipient_ownership = 'owned_by_other' then 'duplicate_or_shared_recipient' end,
      case when initial_email_mode = 'template' then 'template_mode' end,
      case when initial_email_mode = 'ai_personalised' then 'personalised_mode' end,
      case when not personalisation_complete then 'missing_research' end,
      case when personalisation_complete then 'completed_research' end,
      case when initial_email_state = 'sent' and follow_up_1_state <> 'sent'
        and extract(epoch from (as_of - initial_sent_at)) / 86400 >= follow_up_1_days then 'fu1_eligible' end,
      case when initial_email_state = 'sent' and follow_up_1_state = 'sent' and follow_up_2_state <> 'sent'
        and extract(epoch from (as_of - initial_sent_at)) / 86400 >= follow_up_2_days then 'fu2_eligible' end,
      case when initial_email_state = 'sent' and follow_up_1_state = 'sent' and follow_up_2_state = 'sent'
        and follow_up_3_state <> 'sent'
        and extract(epoch from (as_of - initial_sent_at)) / 86400 >= follow_up_3_days then 'fu3_eligible' end,
      case when initial_email_state = 'sent' and follow_up_1_state = 'sent' and follow_up_2_state = 'sent'
        and follow_up_3_state = 'sent' and reactivation_sent_at is null and reactivation_enabled
        and extract(epoch from (as_of - initial_sent_at)) / 86400 >= reactivation_delay_days then 'reactivation_eligible' end,
      case when reply_received then 'reply_present' end,
      case when not category_id_present then 'null_category_id' end,
      case when initial_email_state = 'uncertain' or follow_up_1_state = 'uncertain'
        or follow_up_2_state = 'uncertain' or follow_up_3_state = 'uncertain' then 'send_uncertainty' end,
      -- Template readiness only means something for leads actually in template mode.
      case when initial_email_mode = 'template' and template_available
        and required_template_data_available then 'template_ready' end,
      case when follow_up_3_state = 'sent'
        and (follow_up_1_state <> 'sent' or follow_up_2_state <> 'sent') then 'broken_followup_sequence' end,
      case when reactivation_sent_at is not null then 'post_reactivation_window' end,
      case when manual_source then 'manual_source' end
    ], null) as cohorts
  from facts f
),
population_totals as (
  select count(*)::bigint as population_total from labeled
),
status_totals as (
  select status, count(*)::bigint as status_total from labeled group by status
),
excluded_totals as (
  -- Leads whose status is outside the canonical Decision Engine set are never
  -- sampled. Counting them keeps the coverage claim in the report honest.
  select count(*)::bigint as excluded_total
  from public.leads l
  where l.status is null
     or l.status not in (
       'new', 'researched', 'email_ready', 'contacted', 'replied',
       'interested', 'negotiating', 'closed', 'closed_manual', 'dead'
     )
),
-- Four priority tiers. Tiers 0 and 10 hold one representative of every cohort
-- and every status, and together stay well under the 100-row cap, so coverage is
-- guaranteed regardless of how the population is skewed. Tiers 20 and 30 add
-- depth, and tier 100 fills any remaining slots.
status_ranked as (
  select lead_id, case when rank_in_status = 1 then 10 else 30 end as priority
  from (
    select lead_id, row_number() over (partition by status order by md5(lead_id::text)) as rank_in_status
    from labeled
  ) ranked
  where rank_in_status <= 5
),
cohort_ranked as (
  select lead_id, case when rank_in_cohort = 1 then 0 else 20 end as priority
  from (
    select l.lead_id, row_number() over (partition by cohort order by md5(l.lead_id::text)) as rank_in_cohort
    from labeled l
    cross join lateral unnest(l.cohorts) cohort
  ) ranked
  where rank_in_cohort <= 3
),
candidate_ids as (
  select lead_id, min(priority) as priority
  from (
    select * from cohort_ranked
    union all
    select * from status_ranked
    union all
    select lead_id, 100 as priority from labeled
  ) candidates
  group by lead_id
),
selected_ids as (
  select lead_id
  from candidate_ids
  order by priority, md5(lead_id::text)
  limit 100
)
select
  l.lead_id,
  l.status,
  l.category_id,
  l.manual_source,
  l.category_id_present,
  l.has_email,
  l.has_business_name,
  l.has_category_name,
  l.has_city,
  l.has_website,
  l.suppressed,
  l.duplicate,
  l.recipient_ownership,
  l.deal_state,
  l.initial_email_mode,
  l.contact_discovery_complete,
  l.personalisation_complete,
  l.can_supply_template_fields,
  l.template_available,
  l.required_template_placeholders,
  l.required_template_data_available,
  l.initial_email_state,
  l.initial_sent_at,
  l.follow_up_1_state,
  l.follow_up_1_sent_at,
  l.follow_up_2_state,
  l.follow_up_2_sent_at,
  l.follow_up_3_state,
  l.follow_up_3_sent_at,
  l.reply_received,
  l.reply_classification,
  l.reactivation_enabled,
  l.reactivation_sent_at,
  l.follow_up_1_days,
  l.follow_up_2_days,
  l.follow_up_3_days,
  l.dead_lead_days,
  l.reactivation_delay_days,
  l.dead_after_reactivation_days,
  l.as_of,
  l.cohorts,
  pt.population_total,
  st.status_total as population_status_total,
  et.excluded_total as population_excluded_status_total
from labeled l
join selected_ids selected on selected.lead_id = l.lead_id
join status_totals st on st.status = l.status
cross join population_totals pt
cross join excluded_totals et
order by md5(l.lead_id::text)
limit 100;
