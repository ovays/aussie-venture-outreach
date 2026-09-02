-- Additive Hostinger inbound reliability support. Safe to rerun.
ALTER TABLE public.inbound_receipts
  ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;

-- Thread matching checks exact outbound Message-IDs. NULL rows cannot match.
CREATE INDEX IF NOT EXISTS emails_message_id_not_null_idx
  ON public.emails (message_id)
  WHERE message_id IS NOT NULL;

-- Atomically claim a receipt for processing. Fresh processing rows cannot be
-- claimed by another run; crashed work becomes reclaimable after the caller's
-- deterministic stale cutoff. Each successful claim is one processing attempt.
CREATE OR REPLACE FUNCTION public.claim_hostinger_inbound_receipt(
  p_receipt_id UUID,
  p_run_id TEXT,
  p_stale_before TIMESTAMPTZ
)
RETURNS TABLE (receipt_id UUID, attempt_count INTEGER)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.inbound_receipts
  SET status = 'processing',
      processing_run_id = p_run_id,
      processing_started_at = NOW(),
      attempts = attempts + 1,
      last_error = NULL,
      updated_at = NOW()
  WHERE id = p_receipt_id
    AND provider = 'hostinger'
    AND (
      status IN ('pending', 'queued', 'failed')
      OR (
        status = 'processing'
        AND (
          processing_run_id = p_run_id
          OR COALESCE(processing_started_at, updated_at) < p_stale_before
        )
      )
    )
  RETURNING id, attempts;
$$;

REVOKE ALL ON FUNCTION public.claim_hostinger_inbound_receipt(UUID, TEXT, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_hostinger_inbound_receipt(UUID, TEXT, TIMESTAMPTZ) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_hostinger_inbound_receipt(UUID, TEXT, TIMESTAMPTZ) TO service_role;
