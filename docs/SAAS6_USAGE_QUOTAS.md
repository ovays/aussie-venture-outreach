# SaaS 6 — Usage, entitlements and quotas

SaaS 6 adds deterministic, workspace-scoped entitlements and quota enforcement. It does not add pricing, billing, Stripe, Redis, vector storage, MCP, schedules, or production cutover behavior.

## Migration and data model

The only SaaS 6 migration is `supabase-v2/migrations/00000000000014_usage_quotas.sql`.

It adds:

- `entitlement_profiles` and `entitlement_limits`: a plan catalog with machine-readable limits and no commercial pricing.
- `workspace_entitlements`: one entitlement assignment per workspace.
- `workspace_entitlement_overrides`: the current per-workspace override for a dimension.
- `workspace_entitlement_override_audit`: append-only set/clear history with actor, value, notes, and timestamp.
- `workspace_usage_periods`: UTC calendar-month periods created on first use.
- `workspace_usage_counters`: aggregate consumable usage for a workspace, period, and dimension.
- `workspace_usage_events`: a minimal idempotency ledger for logical operations.

Counter and event rows use composite foreign keys to ensure their `workspace_id` matches their usage period. All new tenant rows are workspace keyed.

## Dimensions

| Dimension | Meaning | Enforcement |
| --- | --- | --- |
| `outbound_email` | Durable outbound email intent presented to a provider | Atomic consumption before provider execution |
| `ai_request` | Logical AI provider request | Atomic consumption before provider execution; provider-internal retries charge once |
| `discovery_request` | External Google Places or Outscraper request | Atomic consumption immediately before each external call; cache hits charge zero |
| `workspace_member` | Active workspace members | Live count plus concurrency-safe database trigger |
| `mailbox_connection` | Non-disconnected database mailbox connections | Live count plus concurrency-safe database trigger |
| `stored_lead` | Stored workspace leads | Visible live count; structural dimension only in SaaS 6 |

`NULL` means unlimited. It is distinct from no entitlement: workspaces without an entitlement fail closed. A nullable override genuinely overrides a finite profile limit with unlimited.

## Atomicity and idempotency

`consume_workspace_quota` is service-role only. It creates the current UTC period and zero counter if needed, inserts a uniquely keyed usage event, and conditionally increments the counter with `used + amount <= limit` in one database transaction. PostgreSQL row locking serializes competing updates, so concurrent callers cannot exceed a finite limit.

The unique key is `(workspace_id, usage_period_id, dimension_key, idempotency_key)`. A retry with the same logical key returns `already_consumed=true` and does not increment again. Outbound email uses its durable email-intent UUID. AI derives a stable digest from workflow/run context and request content unless a caller supplies a stronger key. Discovery hashes provider, query, and page offset; a Google failure followed by an Outscraper fallback is two actual external requests and therefore two distinct keys.

Member and mailbox triggers take a transaction-scoped advisory lock derived from workspace and dimension before counting. They cover inserts and inactive/disconnected-to-active transitions. They never delete or deactivate existing records.

Usage is reserved immediately before the external provider boundary. A provider failure does not refund quota automatically because an ambiguous network failure may have reached the provider. The stable idempotency key prevents a retry from charging twice.

## Integrations

- Outbound email: `sendThroughWorkspaceMailbox` consumes quota before Resend, Gmail, or Microsoft execution. Workspace daily digests and confirmed test sends also consume at their direct Resend boundary. Existing sender locks, suppression checks, recipient ownership, durable intent claims, canary constraints, and provider idempotency remain intact.
- AI: the runtime registry consumes before a configured provider call. Missing server-resolved workspace context fails closed. No browser workspace identifier is accepted.
- Finder: cached searches do not consume quota. Google and Outscraper calls consume at their immediate provider boundaries; a real fallback consumes separately.
- Mailboxes: a database trigger enforces the count on OAuth upsert/reconnection without altering tokens or existing connections.
- Members: a database trigger enforces active membership count on inserts and activation transitions.

## Internal beta entitlement

The migration creates the non-commercial `internal_beta` entitlement with all six limits set to unlimited and assigns it to every workspace already present at migration time, including Aussie Venture (`00000000-0000-0000-0000-000000000001`). This is staging/internal configuration only and does not represent public pricing.

## API and UI

- `GET /api/usage` resolves the authenticated workspace on the server and returns its overview. It accepts no browser-supplied workspace ID.
- `GET /api/admin/usage` lists workspaces for platform admins. A platform admin may explicitly inspect an existing workspace.
- `POST /api/admin/usage` validates platform-admin set/clear override and entitlement operations. Override actions record the authenticated actor.
- Settings includes **Usage & Limits**, with current entitlement, usage, limits, and monthly period.
- Platform Admin includes workspace entitlement/usage visibility and override controls.

## Security and RLS

Authenticated users receive read-only access to the generic entitlement catalog and their own workspace entitlement/usage rows. Override and event detail is limited to workspace admins/platform admins; the override audit is platform-admin only. Browser roles receive no quota RPC execution grant and no mutation grants on quota tables. Mutation RPCs explicitly require `service_role`.

Application APIs resolve workspace authority from active `workspace_members`. The member-facing endpoint has no workspace parameter. The platform-admin endpoint first requires the platform role and validates targeted workspace existence. Service-role usage is isolated behind these server authorization boundaries.

The local negative test verifies cross-workspace RLS and that an authenticated browser role cannot call the consumption RPC.

## Verification

Run the focused local test only against the disposable local V2 database on `127.0.0.1:54322`:

```text
npm run test:usage-quotas:v2
```

It verifies the Aussie Venture beta seed, concurrent atomic consumption, concurrent idempotent retries, member and mailbox guards, cross-workspace RLS, browser RPC denial, and integration boundary presence. It performs no email, AI, Finder, Trigger.dev, V1, or hosted calls.

Then run the standard V2 checks listed in the SaaS 6 handoff.

## Hosted V2 manual step

Do not use the old baseline apply script and do not repair migration history. In the Supabase dashboard, select project `ojrxfjlgjhzhdpnkyboa`, open SQL Editor, paste the complete unchanged contents of `supabase-v2/migrations/00000000000014_usage_quotas.sql`, confirm the editor is connected to that V2 project (not V1 `obppfnujusqiwjhwzosv`), and execute it exactly once. Keep all send, AI, Finder, and Trigger gates disabled while applying and verifying.

After application, verify the migration objects and the Aussie Venture assignment before deploying application code. Do not apply this migration to V1.

## Next phase

SaaS 7 should introduce billing/Stripe mapping onto the existing plan codes and deterministic entitlement assignment. It should not replace the SaaS 6 counters, idempotency ledger, provider gates, or workspace authorization model.
