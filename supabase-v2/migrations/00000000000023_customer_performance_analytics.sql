-- Prompt 7: bounded customer reads and customer-safe performance analytics.
-- Additive only. No execution, provider, scheduling, or V1 behaviour is changed.

CREATE INDEX IF NOT EXISTS emails_workspace_lead_sent_at_idx
  ON public.emails (workspace_id, lead_id, sent_at DESC)
  WHERE sent_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS emails_workspace_lead_replied_at_idx
  ON public.emails (workspace_id, lead_id, replied_at DESC)
  WHERE replied_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS customer_inbound_messages_workspace_received_idx
  ON public.customer_inbound_messages (workspace_id, received_at DESC);

GRANT reachagent_function_owner TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
GRANT CREATE ON SCHEMA public TO reachagent_function_owner;

-- Migration 21 created this function as the migration executor. Transfer it
-- before assuming the dedicated owner so CREATE OR REPLACE remains legal.
ALTER FUNCTION public.get_customer_leads_page(
  uuid,
  text,
  text,
  integer,
  integer,
  timestamptz
) OWNER TO reachagent_function_owner;

GRANT SELECT ON public.leads, public.emails, public.activity_log,
  public.workspace_settings, public.customer_inbound_messages
TO reachagent_function_owner;
GRANT EXECUTE ON FUNCTION public.literal_ilike_pattern(text)
TO reachagent_function_owner;

SET ROLE reachagent_function_owner;

CREATE OR REPLACE FUNCTION public.get_customer_leads_page(
  p_workspace_id uuid, p_status text DEFAULT 'all', p_search text DEFAULT '',
  p_page integer DEFAULT 1, p_page_size integer DEFAULT 25,
  p_as_of timestamptz DEFAULT now()
) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
WITH validated AS (
  SELECT CASE WHEN p_status IN ('all','new','email_ready','contacted','replied','interested','not_interested','reactivation_due','dead') THEN p_status ELSE 'all' END status_filter,
    btrim(COALESCE(p_search,'')) search_term, GREATEST(COALESCE(p_page,1),1) page_number,
    LEAST(GREATEST(COALESCE(p_page_size,25),1),50) page_size
), settings AS (
  SELECT COALESCE((substring(max(value) FILTER (WHERE key='reactivation_delay_days') FROM '^[+-]?[0-9]+'))::integer,90) react_days,
    COALESCE(max(value) FILTER (WHERE key='reactivation_enabled')='true',false) react_enabled
  FROM public.workspace_settings WHERE workspace_id=p_workspace_id
), searched_leads AS MATERIALIZED (
  SELECT l.id,l.business_name,l.category_name,l.city,l.suburb,l.email,l.status raw_status,l.customer_outcome,l.created_at
  FROM public.leads l CROSS JOIN validated v
  WHERE l.workspace_id=p_workspace_id AND (v.search_term='' OR
    l.business_name ILIKE '%'||public.literal_ilike_pattern(v.search_term)||'%' ESCAPE E'\\' OR
    COALESCE(l.email,'') ILIKE '%'||public.literal_ilike_pattern(v.search_term)||'%' ESCAPE E'\\' OR
    COALESCE(l.city,'') ILIKE '%'||public.literal_ilike_pattern(v.search_term)||'%' ESCAPE E'\\' OR
    COALESCE(l.suburb,'') ILIKE '%'||public.literal_ilike_pattern(v.search_term)||'%' ESCAPE E'\\' OR
    COALESCE(l.category_name,'') ILIKE '%'||public.literal_ilike_pattern(v.search_term)||'%' ESCAPE E'\\')
), email_facts AS MATERIALIZED (
  SELECT e.lead_id, max(e.sent_at) last_contact_at, bool_or(e.replied_at IS NOT NULL) has_reply,
    (array_agg(e.sent_at ORDER BY e.created_at,e.id)
      FILTER (WHERE e.type='initial_pitch' AND e.sent_at IS NOT NULL))[1] initial_sent_at,
    bool_or(e.sent_at IS NOT NULL) FILTER (WHERE e.type='follow_up_1') fu1_sent,
    bool_or(e.sent_at IS NOT NULL) FILTER (WHERE e.type='follow_up_2') fu2_sent,
    bool_or(e.sent_at IS NOT NULL) FILTER (WHERE e.type='follow_up_3') fu3_sent
  FROM public.emails e JOIN searched_leads l ON l.id=e.lead_id
  WHERE e.workspace_id=p_workspace_id
    AND (e.sent_at IS NOT NULL OR e.replied_at IS NOT NULL)
    AND e.type IN ('initial_pitch','follow_up_1','follow_up_2','follow_up_3','reactivation')
  GROUP BY e.lead_id
), classified AS MATERIALIZED (
  SELECT l.*,f.last_contact_at,COALESCE(f.has_reply,false) has_reply,
    CASE WHEN l.customer_outcome='not_interested' THEN 'not_interested'
      WHEN l.customer_outcome='interested' THEN 'interested'
      WHEN l.raw_status='contacted' AND s.react_enabled AND f.initial_sent_at IS NOT NULL
        AND COALESCE(f.fu1_sent,false) AND COALESCE(f.fu2_sent,false) AND COALESCE(f.fu3_sent,false)
        AND f.initial_sent_at+make_interval(days=>s.react_days)<=p_as_of THEN 'reactivation_due'
      WHEN l.raw_status='email_ready' THEN 'email_ready'
      WHEN l.raw_status='contacted' THEN 'contacted'
      WHEN l.raw_status='replied' THEN 'replied'
      WHEN l.raw_status IN ('interested','negotiating','closed','closed_manual') THEN 'interested'
      WHEN l.raw_status='dead' THEN 'dead' ELSE 'new' END customer_status
  FROM searched_leads l LEFT JOIN email_facts f ON f.lead_id=l.id CROSS JOIN settings s
), matched AS MATERIALIZED (
  SELECT c.* FROM classified c CROSS JOIN validated v WHERE v.status_filter='all' OR c.customer_status=v.status_filter
), paged AS (
  SELECT * FROM matched ORDER BY created_at DESC NULLS LAST,id
  OFFSET (SELECT (page_number::bigint-1)*page_size::bigint FROM validated) LIMIT (SELECT page_size FROM validated)
), records AS (
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'business_name',business_name,'category_name',category_name,
    'location',concat_ws(', ',NULLIF(suburb,''),NULLIF(city,'')),'email',email,'customer_status',customer_status,
    'last_contact_at',last_contact_at,'has_reply',has_reply) ORDER BY created_at DESC NULLS LAST,id),'[]'::jsonb) value FROM paged
), counts AS (
  SELECT jsonb_build_object('all',count(*),'new',count(*) FILTER(WHERE customer_status='new'),
    'email_ready',count(*) FILTER(WHERE customer_status='email_ready'),'contacted',count(*) FILTER(WHERE customer_status='contacted'),
    'replied',count(*) FILTER(WHERE customer_status='replied'),'interested',count(*) FILTER(WHERE customer_status='interested'),
    'not_interested',count(*) FILTER(WHERE customer_status='not_interested'),'reactivation_due',count(*) FILTER(WHERE customer_status='reactivation_due'),
    'dead',count(*) FILTER(WHERE customer_status='dead')) value FROM classified
), recent_activity AS (
  SELECT COALESCE(jsonb_agg(row_value ORDER BY created_at DESC),'[]'::jsonb) value FROM (
    SELECT a.created_at,jsonb_build_object('id',a.id,'created_at',a.created_at,'event_type',a.event_type,'business_name',l.business_name) row_value
    FROM public.activity_log a JOIN public.leads l ON l.id=a.lead_id AND l.workspace_id=p_workspace_id
    WHERE a.workspace_id=p_workspace_id AND a.event_type IN ('lead_found','lead_created','email_sent','follow_up_1_sent','follow_up_2_sent','follow_up_3_sent','reply_received','customer_outcome_interested','customer_outcome_not_interested','customer_outcome_cleared')
    ORDER BY a.created_at DESC LIMIT 20
  ) events
)
SELECT jsonb_build_object('data',records.value,'total',(SELECT count(*) FROM matched),'page',v.page_number,'page_size',v.page_size,'counts',counts.value,'recent_activity',recent_activity.value)
FROM validated v CROSS JOIN records CROSS JOIN counts CROSS JOIN recent_activity;
$$;

CREATE OR REPLACE FUNCTION public.get_customer_inbox_page(
  p_workspace_id uuid, p_page integer DEFAULT 1, p_page_size integer DEFAULT 25
) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'pg_catalog','public'
AS $$
WITH v AS (SELECT GREATEST(COALESCE(p_page,1),1) page_number,LEAST(GREATEST(COALESCE(p_page_size,25),1),25) page_size),
matched AS MATERIALIZED (
  SELECT l.id,l.business_name,l.email,l.customer_outcome,l.outreach_suppressed_at,l.updated_at
  FROM public.leads l WHERE l.workspace_id=p_workspace_id AND EXISTS (
    SELECT 1 FROM public.emails e WHERE e.workspace_id=p_workspace_id AND e.lead_id=l.id AND e.sent_at IS NOT NULL)
), paged AS (
  SELECT m.* FROM matched m ORDER BY m.updated_at DESC,m.id
  OFFSET (SELECT (page_number::bigint-1)*page_size::bigint FROM v) LIMIT (SELECT page_size FROM v)
), rows AS (
  SELECT p.*,sent.subject,sent.sent_at,sent.replied_at,inbound.received_at,
    GREATEST(sent.sent_at,sent.replied_at,inbound.received_at) last_message_at
  FROM paged p
  LEFT JOIN LATERAL (
    SELECT
      (array_agg(e.subject ORDER BY e.sent_at DESC,e.id) FILTER (WHERE e.sent_at IS NOT NULL))[1] subject,
      max(e.sent_at) sent_at,
      max(e.replied_at) replied_at
    FROM public.emails e
    WHERE e.workspace_id=p_workspace_id AND e.lead_id=p.id
      AND (e.sent_at IS NOT NULL OR e.replied_at IS NOT NULL)
  ) sent ON true
  LEFT JOIN LATERAL (SELECT i.received_at FROM public.customer_inbound_messages i WHERE i.workspace_id=p_workspace_id AND i.lead_id=p.id ORDER BY i.received_at DESC LIMIT 1) inbound ON true
), payload AS (
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'business_name',business_name,'email',email,'subject',subject,
    'last_message_at',last_message_at,'state',CASE WHEN received_at IS NOT NULL OR replied_at IS NOT NULL THEN 'replied' ELSE 'sent' END,
    'outcome',customer_outcome,'suppression',CASE WHEN outreach_suppressed_at IS NOT NULL THEN 'suppressed' END)
    ORDER BY updated_at DESC,id),'[]'::jsonb) data FROM rows
)
SELECT jsonb_build_object('data',payload.data,'total',(SELECT count(*) FROM matched),'page',v.page_number,'page_size',v.page_size) FROM v CROSS JOIN payload;
$$;

CREATE OR REPLACE FUNCTION public.get_customer_analytics(
  p_workspace_id uuid, p_as_of timestamptz DEFAULT now()
) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'pg_catalog','public'
AS $$
-- Contacted, replies, and interested are unique contacted leads. A reply is
-- evidenced by either legacy emails.replied_at or durable inbound metadata.
-- Trend buckets are distinct leads on the displayed Australia/Sydney date.
WITH bounds AS (
  SELECT (p_as_of AT TIME ZONE 'Australia/Sydney')::date end_day,
    (p_as_of AT TIME ZONE 'Australia/Sydney')::date-13 start_day
), facts AS MATERIALIZED (
  SELECT l.id,COALESCE(NULLIF(l.category_name,''),'Uncategorised') category_name,l.customer_outcome,
    EXISTS(SELECT 1 FROM public.emails e WHERE e.workspace_id=p_workspace_id AND e.lead_id=l.id AND e.sent_at IS NOT NULL) contacted,
    (EXISTS(SELECT 1 FROM public.emails e WHERE e.workspace_id=p_workspace_id AND e.lead_id=l.id AND e.replied_at IS NOT NULL)
      OR EXISTS(SELECT 1 FROM public.customer_inbound_messages i WHERE i.workspace_id=p_workspace_id AND i.lead_id=l.id)) replied
  FROM public.leads l WHERE l.workspace_id=p_workspace_id
), totals AS (
  SELECT count(*) total_leads,count(*) FILTER(WHERE contacted) contacted,
    count(*) FILTER(WHERE contacted AND replied) replies,
    count(*) FILTER(WHERE contacted AND customer_outcome='interested') interested,
    count(*) FILTER(WHERE customer_outcome='not_interested') not_interested FROM facts
), days AS (
  SELECT generate_series(b.start_day,b.end_day,interval '1 day')::date AS activity_day FROM bounds b
), contacted_activity AS (
  SELECT (e.sent_at AT TIME ZONE 'Australia/Sydney')::date AS activity_day,e.lead_id
  FROM public.emails e CROSS JOIN bounds b
  WHERE e.workspace_id=p_workspace_id AND e.sent_at IS NOT NULL
    AND e.sent_at >= b.start_day::timestamp AT TIME ZONE 'Australia/Sydney'
    AND e.sent_at < (b.end_day+1)::timestamp AT TIME ZONE 'Australia/Sydney'
  GROUP BY 1,e.lead_id
), reply_activity AS (
  SELECT reply_events.activity_day,reply_events.lead_id FROM (
    SELECT (e.replied_at AT TIME ZONE 'Australia/Sydney')::date AS activity_day,e.lead_id
    FROM public.emails e CROSS JOIN bounds b
    WHERE e.workspace_id=p_workspace_id AND e.replied_at IS NOT NULL
      AND e.replied_at >= b.start_day::timestamp AT TIME ZONE 'Australia/Sydney'
      AND e.replied_at < (b.end_day+1)::timestamp AT TIME ZONE 'Australia/Sydney'
    UNION
    SELECT (i.received_at AT TIME ZONE 'Australia/Sydney')::date AS activity_day,i.lead_id
    FROM public.customer_inbound_messages i CROSS JOIN bounds b
    WHERE i.workspace_id=p_workspace_id
      AND i.received_at >= b.start_day::timestamp AT TIME ZONE 'Australia/Sydney'
      AND i.received_at < (b.end_day+1)::timestamp AT TIME ZONE 'Australia/Sydney'
  ) reply_events GROUP BY reply_events.activity_day,reply_events.lead_id
), contacted_daily AS (
  SELECT activity_day,count(*) contacted FROM contacted_activity GROUP BY activity_day
), reply_daily AS (
  SELECT activity_day,count(*) replies FROM reply_activity GROUP BY activity_day
), daily AS (
  SELECT d.activity_day,COALESCE(c.contacted,0) contacted,COALESCE(r.replies,0) replies
  FROM days d LEFT JOIN contacted_daily c ON c.activity_day=d.activity_day LEFT JOIN reply_daily r ON r.activity_day=d.activity_day
), trend AS (
  SELECT jsonb_agg(jsonb_build_object('date',activity_day,'contacted',contacted,'replies',replies) ORDER BY activity_day) value FROM daily
), categories AS (
  SELECT COALESCE(jsonb_agg(jsonb_build_object('category',category_name,'total_leads',total_leads,'contacted',contacted,'replies',replies,'interested',interested,'reply_rate',CASE WHEN contacted=0 THEN 0 ELSE round(replies*100.0/contacted,1) END) ORDER BY contacted DESC,category_name),'[]'::jsonb) value
  FROM (SELECT category_name,count(*) total_leads,count(*) FILTER(WHERE contacted) contacted,
    count(*) FILTER(WHERE contacted AND replied) replies,
    count(*) FILTER(WHERE contacted AND customer_outcome='interested') interested
    FROM facts GROUP BY category_name ORDER BY contacted DESC LIMIT 10) c
)
SELECT jsonb_build_object('total_leads',t.total_leads,'contacted',t.contacted,'replies',t.replies,'interested',t.interested,'not_interested',t.not_interested,
  'reply_rate',CASE WHEN t.contacted=0 THEN 0 ELSE round(t.replies*100.0/t.contacted,1) END,
  'interested_rate',CASE WHEN t.contacted=0 THEN 0 ELSE round(t.interested*100.0/t.contacted,1) END,
  'trend',trend.value,'categories',categories.value) FROM totals t CROSS JOIN trend CROSS JOIN categories;
$$;

ALTER FUNCTION public.get_customer_leads_page(uuid,text,text,integer,integer,timestamptz) OWNER TO reachagent_function_owner;
ALTER FUNCTION public.get_customer_inbox_page(uuid,integer,integer) OWNER TO reachagent_function_owner;
ALTER FUNCTION public.get_customer_analytics(uuid,timestamptz) OWNER TO reachagent_function_owner;
REVOKE ALL ON FUNCTION public.get_customer_leads_page(uuid,text,text,integer,integer,timestamptz) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.get_customer_inbox_page(uuid,integer,integer) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.get_customer_analytics(uuid,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.get_customer_leads_page(uuid,text,text,integer,integer,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_customer_inbox_page(uuid,integer,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_customer_analytics(uuid,timestamptz) TO service_role;

RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM reachagent_function_owner;
REVOKE reachagent_function_owner FROM CURRENT_USER GRANTED BY CURRENT_USER;
