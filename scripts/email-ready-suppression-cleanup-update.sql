-- MUTATING PRODUCTION CLEANUP. Do not run until the dry-run rows are reviewed.
-- Targets only existing active ownership conflicts and exact normalized addresses
-- already present in delivery_suppressed_emails. It does not infer identity from
-- business name, domain, or data-quality group classification.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ;

UPDATE public.emails e
SET status = CASE
  WHEN lower(btrim(l.email)) = ANY(l.delivery_suppressed_emails) THEN 'suppressed'
  ELSE 'failed'
END
FROM public.leads l
LEFT JOIN public.recipient_outreach_ownership o
  ON o.normalized_email = l.normalized_email
WHERE e.lead_id = l.id
  AND e.type = 'initial_pitch'
  AND e.status = 'pending_send'
  AND l.status = 'email_ready'
  AND (
    (o.state = 'active' AND o.owner_lead_id IS NOT NULL AND o.owner_lead_id <> l.id)
    OR lower(btrim(l.email)) = ANY(l.delivery_suppressed_emails)
  );

UPDATE public.leads l
SET
  status = 'researched',
  outreach_suppression_reason = CASE
    WHEN o.state = 'active' AND o.owner_lead_id IS NOT NULL AND o.owner_lead_id <> l.id
      THEN 'email_already_contacted'
    ELSE l.outreach_suppression_reason
  END,
  outreach_suppressed_at = CASE
    WHEN o.state = 'active' AND o.owner_lead_id IS NOT NULL AND o.owner_lead_id <> l.id
      THEN COALESCE(l.outreach_suppressed_at, now())
    ELSE l.outreach_suppressed_at
  END,
  updated_at = now()
FROM public.recipient_outreach_ownership o
WHERE l.status = 'email_ready'
  AND o.normalized_email = l.normalized_email
  AND o.state = 'active'
  AND o.owner_lead_id IS NOT NULL
  AND o.owner_lead_id <> l.id;

UPDATE public.leads l
SET status = 'researched', updated_at = now()
WHERE l.status = 'email_ready'
  AND lower(btrim(l.email)) = ANY(l.delivery_suppressed_emails);

COMMIT;
