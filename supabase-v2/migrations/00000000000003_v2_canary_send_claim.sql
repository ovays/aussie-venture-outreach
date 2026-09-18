-- ReachAgent V2 tiny canary prerequisite: durable send claim states and envelope.
-- No operational data or production behavior is changed here. The claim itself is
-- performed by the application as a single conditional UPDATE (pending_send ->
-- sending); this migration only adds the required durable states and envelope
-- columns plus the tightened open/delivered uniqueness guard.

ALTER TABLE public.emails
  DROP CONSTRAINT IF EXISTS emails_status_check;

ALTER TABLE public.emails
  ADD CONSTRAINT emails_status_check
  CHECK (status = ANY (ARRAY[
    'pending_send'::text,
    'sending'::text,
    'sent'::text,
    'delivery_uncertain'::text,
    'failed'::text,
    'bounced'::text,
    'suppressed'::text,
    'email_sync_failed'::text
  ]));

ALTER TABLE public.emails
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS send_envelope jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.emails
  ADD CONSTRAINT emails_send_envelope_object CHECK (jsonb_typeof(send_envelope) = 'object');

-- A claimed ("sending") or uncertain intent still occupies the lead/phase slot so
-- no concurrent worker can insert a replacement pending intent.
DROP INDEX IF EXISTS public.emails_lead_type_open_or_delivered_key;
CREATE UNIQUE INDEX emails_lead_type_open_or_delivered_key
  ON public.emails (lead_id, type)
  WHERE status IN ('pending_send', 'sending', 'sent', 'delivery_uncertain', 'email_sync_failed');
