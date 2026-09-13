-- READ ONLY. Review this result before running the separate update script.
WITH candidates AS (
  SELECT
    l.id AS lead_id,
    l.status AS current_status,
    l.normalized_email,
    o.owner_lead_id AS current_owner_lead_id,
    CASE
      WHEN o.state = 'active' AND o.owner_lead_id IS NOT NULL AND o.owner_lead_id <> l.id
        THEN 'email_already_contacted'
      WHEN lower(btrim(l.email)) = ANY(l.delivery_suppressed_emails)
        THEN 'delivery_suppressed_email'
    END AS proposed_suppression_reason,
    CASE
      WHEN o.state = 'active' AND o.owner_lead_id IS NOT NULL AND o.owner_lead_id <> l.id
        THEN COALESCE(l.outreach_suppressed_at, now())
      ELSE l.outreach_suppressed_at
    END AS proposed_suppression_timestamp,
    l.outreach_suppression_reason AS current_suppression_reason,
    l.outreach_suppressed_at AS current_suppression_timestamp
  FROM public.leads l
  LEFT JOIN public.recipient_outreach_ownership o
    ON o.normalized_email = l.normalized_email
  WHERE l.status = 'email_ready'
    AND (
      (o.state = 'active' AND o.owner_lead_id IS NOT NULL AND o.owner_lead_id <> l.id)
      OR lower(btrim(l.email)) = ANY(l.delivery_suppressed_emails)
    )
)
SELECT *
FROM candidates
ORDER BY proposed_suppression_reason, normalized_email, lead_id;
