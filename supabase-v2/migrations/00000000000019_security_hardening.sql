-- SaaS 9C: atomic final outbound authority check.
--
-- The provider boundary must not rely on a suppression/ownership read made
-- earlier in the workflow. This service-only claim locks the email and lead,
-- re-resolves the recipient from durable state, and fails closed if workspace,
-- suppression, ownership, or idempotency state changed before delivery.

GRANT reachagent_function_owner TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;

-- Serialize every direct owner-removal path at the table boundary. Existing
-- admin RPC checks remain useful for clear errors; this trigger closes the
-- two-concurrent-owner-demotions race even for future service-role writers.
CREATE FUNCTION reachagent_private.protect_final_workspace_owner() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  v_removes_owner boolean := false;
BEGIN
  -- A workspace deletion intentionally cascades all memberships. The parent
  -- row is already absent from the deleting transaction, so do not turn this
  -- guard into an accidental workspace-deletion blocker.
  IF TG_OP = 'DELETE' AND NOT EXISTS (
    SELECT 1 FROM public.workspaces WHERE id = OLD.workspace_id
  ) THEN
    RETURN OLD;
  END IF;
  IF OLD.role = 'owner' AND OLD.status = 'active' THEN
    IF TG_OP = 'DELETE' THEN
      v_removes_owner := true;
    ELSE
      v_removes_owner := NEW.role <> 'owner' OR NEW.status <> 'active';
    END IF;
    IF v_removes_owner THEN
      PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(OLD.workspace_id::text, 82408002)
      );
      IF (
        SELECT pg_catalog.count(*) FROM public.workspace_members
        WHERE workspace_id = OLD.workspace_id AND role = 'owner' AND status = 'active'
      ) <= 1 THEN
        RAISE EXCEPTION 'cannot remove the final active workspace owner' USING ERRCODE = 'P0001';
      END IF;
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;

ALTER FUNCTION reachagent_private.protect_final_workspace_owner()
  OWNER TO reachagent_function_owner;

CREATE TRIGGER protect_final_workspace_owner
  BEFORE UPDATE OF role, status OR DELETE ON public.workspace_members
  FOR EACH ROW EXECUTE FUNCTION reachagent_private.protect_final_workspace_owner();

CREATE FUNCTION public.claim_outbound_email_for_send(
  p_workspace_id uuid,
  p_email_id uuid,
  p_lead_id uuid,
  p_message_id text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  v_role text := COALESCE(
    NULLIF(pg_catalog.current_setting('request.jwt.claim.role', true), ''),
    (NULLIF(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text;
  v_email_status text;
  v_recipient text;
  v_normalized_email text;
  v_suppression_reason text;
  v_suppressed_emails text[];
  v_workspace_status text;
  v_owner uuid;
  v_owner_state text;
BEGIN
  IF v_role <> 'service_role' THEN
    RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501';
  END IF;
  IF p_workspace_id IS NULL OR p_email_id IS NULL OR p_lead_id IS NULL
     OR NULLIF(pg_catalog.btrim(p_message_id), '') IS NULL THEN
    RAISE EXCEPTION 'workspace, email, lead and message id are required' USING ERRCODE = '22023';
  END IF;

  SELECT status INTO v_workspace_status
  FROM public.workspaces
  WHERE id = p_workspace_id
  FOR UPDATE;
  IF v_workspace_status IS DISTINCT FROM 'active' THEN
    RETURN pg_catalog.jsonb_build_object('claimed', false, 'reason', 'workspace_inactive');
  END IF;

  SELECT status INTO v_email_status
  FROM public.emails
  WHERE workspace_id = p_workspace_id AND id = p_email_id AND lead_id = p_lead_id
  FOR UPDATE;
  IF v_email_status IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('claimed', false, 'reason', 'intent_not_found');
  END IF;
  IF v_email_status <> 'pending_send' THEN
    RETURN pg_catalog.jsonb_build_object('claimed', false, 'reason', 'intent_already_claimed');
  END IF;

  SELECT email, normalized_email, outreach_suppression_reason, delivery_suppressed_emails
  INTO v_recipient, v_normalized_email, v_suppression_reason, v_suppressed_emails
  FROM public.leads
  WHERE workspace_id = p_workspace_id AND id = p_lead_id
  FOR UPDATE;
  IF v_normalized_email IS NULL OR NULLIF(pg_catalog.btrim(v_recipient), '') IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('claimed', false, 'reason', 'recipient_invalid');
  END IF;
  IF v_suppression_reason IS NOT NULL
     OR v_normalized_email = ANY(COALESCE(v_suppressed_emails, '{}'::text[])) THEN
    RETURN pg_catalog.jsonb_build_object('claimed', false, 'reason', 'recipient_suppressed');
  END IF;

  SELECT owner_lead_id, state INTO v_owner, v_owner_state
  FROM public.recipient_outreach_ownership
  WHERE workspace_id = p_workspace_id AND normalized_email = v_normalized_email
  FOR UPDATE;
  IF v_owner IS DISTINCT FROM p_lead_id OR v_owner_state IS DISTINCT FROM 'active' THEN
    RETURN pg_catalog.jsonb_build_object('claimed', false, 'reason', 'recipient_not_owned');
  END IF;

  UPDATE public.emails
  SET status = 'sending', claimed_at = pg_catalog.now(), message_id = p_message_id
  WHERE workspace_id = p_workspace_id AND id = p_email_id AND lead_id = p_lead_id
    AND status = 'pending_send';
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('claimed', false, 'reason', 'claim_lost');
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'claimed', true,
    'recipient', v_recipient,
    'normalized_email', v_normalized_email
  );
END
$$;

ALTER FUNCTION public.claim_outbound_email_for_send(uuid, uuid, uuid, text)
  OWNER TO reachagent_function_owner;

REVOKE ALL ON FUNCTION public.claim_outbound_email_for_send(uuid, uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_outbound_email_for_send(uuid, uuid, uuid, text)
  TO service_role;

REVOKE ALL ON FUNCTION reachagent_private.protect_final_workspace_owner()
  FROM PUBLIC, anon, authenticated, service_role;

REVOKE reachagent_function_owner FROM CURRENT_USER GRANTED BY CURRENT_USER;
