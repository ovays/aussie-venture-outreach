-- Durable idempotency ledger for event-driven inbound email processing.
CREATE TABLE IF NOT EXISTS public.inbound_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL CHECK (provider IN ('hostinger', 'resend')),
  receipt_key TEXT NOT NULL UNIQUE,
  mailbox_id TEXT,
  folder TEXT,
  uid TEXT,
  provider_message_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'queued', 'processing', 'processed', 'ignored',
    'unmatched', 'unmatched_ambiguous', 'failed'
  )),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  outcome TEXT,
  trigger_run_id TEXT,
  processing_run_id TEXT,
  processing_started_at TIMESTAMPTZ,
  processed_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS inbound_receipts_status_updated_at_idx
  ON public.inbound_receipts (status, updated_at);

ALTER TABLE public.inbound_receipts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role manages inbound receipts"
  ON public.inbound_receipts FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- If a worker commits reply handling and is interrupted before finalizing its
-- receipt, a retry may repeat the activity insert. This makes that final side
-- effect idempotent while the lead/email updates are already predicate-safe.
CREATE UNIQUE INDEX IF NOT EXISTS activity_log_inbound_receipt_event_key
  ON public.activity_log (event_type, (metadata ->> 'inbound_receipt_id'))
  WHERE metadata ->> 'inbound_receipt_id' IS NOT NULL;
