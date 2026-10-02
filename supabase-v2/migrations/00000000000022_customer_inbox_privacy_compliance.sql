-- Prompt 6: customer Inbox, privacy boundaries, and workspace-scoped suppression.
-- Execution remains paused; this migration does not schedule or send outreach.

CREATE TABLE public.outreach_suppressions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  lead_id uuid REFERENCES public.leads(id) ON DELETE SET NULL,
  normalized_email text NOT NULL,
  source text NOT NULL CHECK (source IN ('recipient_unsubscribe', 'manual_do_not_contact')),
  token_hash text,
  suppressed_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT outreach_suppressions_normalized_email_check
    CHECK (normalized_email = lower(btrim(normalized_email)) AND normalized_email LIKE '%@%'),
  UNIQUE (workspace_id, normalized_email)
);

CREATE UNIQUE INDEX outreach_suppressions_token_hash_idx
  ON public.outreach_suppressions (token_hash) WHERE token_hash IS NOT NULL;
CREATE INDEX outreach_suppressions_workspace_lead_idx
  ON public.outreach_suppressions (workspace_id, lead_id) WHERE lead_id IS NOT NULL;

CREATE TABLE public.unsubscribe_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  lead_id uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  normalized_email text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  used_at timestamptz,
  UNIQUE (workspace_id, lead_id, normalized_email),
  CONSTRAINT unsubscribe_tokens_normalized_email_check
    CHECK (normalized_email = lower(btrim(normalized_email)) AND normalized_email LIKE '%@%')
);

-- Provider-neutral durable storage for customer-visible inbound content. It is
-- deliberately separate from operational inbound_receipts and raw payloads.
CREATE TABLE public.customer_inbound_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  lead_id uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  mailbox_connection_id uuid REFERENCES public.mailbox_connections(id) ON DELETE SET NULL,
  provider text NOT NULL CHECK (provider IN ('gmail', 'microsoft', 'hostinger', 'resend')),
  provider_message_key text NOT NULL,
  from_address text NOT NULL,
  to_addresses text[] NOT NULL DEFAULT '{}',
  subject text,
  body_text text,
  received_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, provider, provider_message_key)
);

CREATE INDEX customer_inbound_messages_workspace_lead_received_idx
  ON public.customer_inbound_messages (workspace_id, lead_id, received_at DESC);

ALTER TABLE public.outreach_suppressions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.unsubscribe_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_inbound_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY outreach_suppressions_member_read ON public.outreach_suppressions
  FOR SELECT TO authenticated
  USING (public.is_workspace_member(workspace_id));
CREATE POLICY outreach_suppressions_admin_manage ON public.outreach_suppressions
  FOR ALL TO authenticated
  USING (public.is_workspace_member(workspace_id, 'admin'))
  WITH CHECK (public.is_workspace_member(workspace_id, 'admin'));
-- Tokens are service-only. They are never returned by authenticated table APIs.
CREATE POLICY customer_inbound_messages_member_read ON public.customer_inbound_messages
  FOR SELECT TO authenticated
  USING (public.is_workspace_member(workspace_id));

-- Platform-admin status alone is not authority to read mailbox content.
DROP POLICY IF EXISTS emails_member_read ON public.emails;
CREATE POLICY emails_member_read ON public.emails
  FOR SELECT TO authenticated
  USING (public.is_workspace_member(workspace_id));

-- Suppression is authoritative at the last database claim before a provider
-- call, and therefore covers initial, follow-up, and reactivation intents.
GRANT SELECT ON public.outreach_suppressions TO reachagent_function_owner;

GRANT reachagent_function_owner TO CURRENT_USER
  WITH INHERIT TRUE, SET TRUE;
GRANT CREATE ON SCHEMA public TO reachagent_function_owner;

SET ROLE reachagent_function_owner;

CREATE OR REPLACE FUNCTION public.claim_outbound_email_for_send(
  p_workspace_id uuid,
  p_email_id uuid,
  p_lead_id uuid,
  p_message_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  v_role text := COALESCE(pg_catalog.current_setting('request.jwt.claim.role', true), '');
  v_workspace_status text;
  v_email_status text;
  v_recipient text;
  v_normalized_email text;
  v_suppression_reason text;
  v_suppressed_emails text[];
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
  SELECT status INTO v_workspace_status FROM public.workspaces
    WHERE id = p_workspace_id FOR UPDATE;
  IF v_workspace_status IS DISTINCT FROM 'active' THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'workspace_inactive');
  END IF;
  SELECT status INTO v_email_status FROM public.emails
    WHERE workspace_id = p_workspace_id AND id = p_email_id AND lead_id = p_lead_id FOR UPDATE;
  IF v_email_status IS NULL THEN RETURN jsonb_build_object('claimed', false, 'reason', 'intent_not_found'); END IF;
  IF v_email_status <> 'pending_send' THEN RETURN jsonb_build_object('claimed', false, 'reason', 'intent_already_claimed'); END IF;
  SELECT email, normalized_email, outreach_suppression_reason, delivery_suppressed_emails
    INTO v_recipient, v_normalized_email, v_suppression_reason, v_suppressed_emails
    FROM public.leads WHERE workspace_id = p_workspace_id AND id = p_lead_id FOR UPDATE;
  IF v_normalized_email IS NULL OR NULLIF(btrim(v_recipient), '') IS NULL THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'recipient_invalid');
  END IF;
  IF v_suppression_reason IS NOT NULL
     OR v_normalized_email = ANY(COALESCE(v_suppressed_emails, '{}'::text[]))
     OR EXISTS (SELECT 1 FROM public.outreach_suppressions s
       WHERE s.workspace_id = p_workspace_id AND s.normalized_email = v_normalized_email) THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'recipient_suppressed');
  END IF;
  SELECT owner_lead_id, state INTO v_owner, v_owner_state
    FROM public.recipient_outreach_ownership
    WHERE workspace_id = p_workspace_id AND normalized_email = v_normalized_email FOR UPDATE;
  IF v_owner IS DISTINCT FROM p_lead_id OR v_owner_state IS DISTINCT FROM 'active' THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'recipient_not_owned');
  END IF;
  UPDATE public.emails SET status = 'sending', claimed_at = now(), message_id = p_message_id
    WHERE workspace_id = p_workspace_id AND id = p_email_id AND lead_id = p_lead_id AND status = 'pending_send';
  IF NOT FOUND THEN RETURN jsonb_build_object('claimed', false, 'reason', 'claim_lost'); END IF;
  RETURN jsonb_build_object('claimed', true, 'recipient', v_recipient, 'normalized_email', v_normalized_email);
END
$$;

ALTER FUNCTION public.claim_outbound_email_for_send(uuid, uuid, uuid, text)
  OWNER TO reachagent_function_owner;
REVOKE ALL ON FUNCTION public.claim_outbound_email_for_send(uuid, uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_outbound_email_for_send(uuid, uuid, uuid, text)
  TO service_role;

RESET ROLE;

REVOKE CREATE ON SCHEMA public FROM reachagent_function_owner;
REVOKE reachagent_function_owner
  FROM CURRENT_USER
  GRANTED BY CURRENT_USER;

GRANT SELECT ON public.outreach_suppressions, public.customer_inbound_messages TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.outreach_suppressions TO authenticated;
GRANT ALL ON public.outreach_suppressions, public.unsubscribe_tokens, public.customer_inbound_messages TO service_role;
