-- Preserve Resend's terminal delivery states and suppress only the failed
-- recipient address (not the lead/business as a whole).
ALTER TABLE emails DROP CONSTRAINT IF EXISTS emails_status_check;
ALTER TABLE emails ADD CONSTRAINT emails_status_check
  CHECK (status IN ('pending_send', 'sent', 'failed', 'bounced', 'suppressed', 'email_sync_failed'));

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS delivery_suppressed_emails TEXT[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN leads.delivery_suppressed_emails IS
  'Normalised recipient addresses with a terminal Resend delivery event. A different lead email remains eligible.';

-- Atomically add an address without losing another concurrently arriving
-- terminal webhook for the same lead.
CREATE OR REPLACE FUNCTION suppress_lead_delivery_email(p_lead_id UUID, p_email TEXT)
RETURNS VOID
LANGUAGE SQL
SET search_path = ''
AS $$
  UPDATE public.leads
  SET delivery_suppressed_emails = CASE
    WHEN pg_catalog.lower(pg_catalog.btrim(p_email)) = ANY(delivery_suppressed_emails)
      THEN delivery_suppressed_emails
    ELSE pg_catalog.array_append(delivery_suppressed_emails, pg_catalog.lower(pg_catalog.btrim(p_email)))
  END
  WHERE id = p_lead_id
    AND pg_catalog.btrim(p_email) <> '';
$$;
