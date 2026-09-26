# SaaS 5 mailbox providers

ReachAgent keeps two email concepts separate:

- **Email Log** is durable outbound history in the workspace-scoped `emails` table.
- **Email Report** is live mailbox metadata read from the selected provider. It is not an inbox clone and does not replace Email Log.

## Provider boundary

`src/lib/mailbox` contains one capability-based provider registry for `gmail`, `microsoft`, `hostinger`, and `resend`. Providers advertise send, inbox, sent-mail, refresh, and webhook capabilities; unsupported operations are absent rather than implemented as no-ops.

The deterministic Decision Engine, suppression and recipient-ownership checks, quotas, durable email intent, and canary gates remain upstream of provider execution. The provider layer executes an already-authorized send only. V2 canary mode remains pinned to the existing Resend canary identity and credential.

Hostinger mailbox reads and inbound webhooks continue to use the existing environment-backed implementation. Resend remains the fallback outbound transport when no connected database mailbox is selected. Gmail and Microsoft use OAuth authorization-code flow with PKCE and on-demand token refresh.

## Required server environment

Do not prefix these values with `NEXT_PUBLIC_` and do not expose them to browser code:

```text
MAILBOX_CREDENTIAL_ENCRYPTION_KEY=<32 random bytes as base64, or 64 hex characters>
MAILBOX_OAUTH_REDIRECT_BASE_URL=https://your-v2-origin.example
GOOGLE_MAILBOX_CLIENT_ID=
GOOGLE_MAILBOX_CLIENT_SECRET=
MICROSOFT_MAILBOX_CLIENT_ID=
MICROSOFT_MAILBOX_CLIENT_SECRET=
MICROSOFT_MAILBOX_TENANT_ID=common
```

Register these exact callback paths with the providers:

```text
https://your-v2-origin.example/api/mailboxes/oauth/gmail/callback
https://your-v2-origin.example/api/mailboxes/oauth/microsoft/callback
```

Google scopes are limited to `gmail.send` and `gmail.readonly`. Microsoft scopes are limited to `offline_access`, `User.Read`, `Mail.Read`, and `Mail.Send`.

OAuth tokens are encrypted with AES-256-GCM before database writes. State is encrypted, short-lived, tied to provider/user/workspace, protected by PKCE, and bound to a short-lived HttpOnly SameSite cookie. Normal mailbox API responses omit workspace ownership, provider account IDs, creator IDs, and credential blobs. Authenticated database sessions have no direct mutation grant and cannot select credential columns.

## Database and rollout

Migration `supabase-v2/migrations/00000000000013_mailbox_connections.sql` adds the workspace-scoped multi-mailbox table, constrained provider/status values, one optional default sender per workspace, RLS, safe column grants, and an updated-at trigger.

Apply migration 13 to hosted V2 before enabling mailbox OAuth. Do not apply it to V1. Configure server environment values, register both callback URLs, deploy, and then connect mailboxes from **Settings → Mailboxes** as a workspace owner/admin or platform admin.

No schedules, Trigger.dev jobs, background mailbox sync, push notifications, mailbox rotation, AI reply authority, billing, or quotas are introduced by SaaS 5.
