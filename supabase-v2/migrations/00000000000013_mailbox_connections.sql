-- ReachAgent SaaS 5: workspace-scoped mailbox connections.
-- OAuth credentials are application-encrypted before they reach this table.

CREATE TABLE public.mailbox_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('gmail', 'microsoft', 'hostinger', 'resend')),
  email_address text NOT NULL,
  display_name text,
  status text NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'expired', 'error', 'disconnected')),
  capabilities jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(capabilities) = 'object'),
  provider_account_id text,
  access_token_encrypted text,
  refresh_token_encrypted text,
  token_expires_at timestamptz,
  scopes text[] NOT NULL DEFAULT '{}',
  is_default_sender boolean NOT NULL DEFAULT false,
  last_connected_at timestamptz,
  last_refreshed_at timestamptz,
  last_sync_at timestamptz,
  last_error_code text,
  last_error_at timestamptz,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mailbox_connections_provider_account_unique
    UNIQUE (workspace_id, provider, provider_account_id)
);

CREATE UNIQUE INDEX mailbox_connections_default_sender_key
  ON public.mailbox_connections (workspace_id)
  WHERE is_default_sender AND status = 'connected';
CREATE INDEX mailbox_connections_workspace_status_idx
  ON public.mailbox_connections (workspace_id, status, provider);

ALTER TABLE public.mailbox_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mailbox_connections FORCE ROW LEVEL SECURITY;

CREATE POLICY mailbox_connections_member_read ON public.mailbox_connections
  FOR SELECT TO authenticated
  USING (public.is_workspace_member(workspace_id) OR public.is_platform_admin());

CREATE POLICY mailbox_connections_admin_manage ON public.mailbox_connections
  FOR ALL TO authenticated
  USING (public.is_workspace_member(workspace_id, 'admin') OR public.is_platform_admin())
  WITH CHECK (public.is_workspace_member(workspace_id, 'admin') OR public.is_platform_admin());

REVOKE ALL ON public.mailbox_connections FROM anon;
REVOKE ALL ON public.mailbox_connections FROM authenticated;
-- Authenticated sessions may read only the non-secret status surface. OAuth
-- account identifiers, encrypted credentials, and creator identifiers remain
-- server/service-role only even if a browser queries Supabase directly.
GRANT SELECT (
  id, workspace_id, provider, email_address, display_name, status,
  capabilities, token_expires_at, scopes, is_default_sender,
  last_connected_at, last_refreshed_at, last_sync_at,
  last_error_code, last_error_at, created_at, updated_at
) ON public.mailbox_connections TO authenticated;
GRANT ALL ON public.mailbox_connections TO service_role;

CREATE FUNCTION public.set_mailbox_connection_updated_at() RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'pg_catalog', 'public' AS $$
BEGIN
  NEW.updated_at := pg_catalog.now();
  RETURN NEW;
END $$;

CREATE TRIGGER mailbox_connections_updated_at
  BEFORE UPDATE ON public.mailbox_connections
  FOR EACH ROW EXECUTE FUNCTION public.set_mailbox_connection_updated_at();
