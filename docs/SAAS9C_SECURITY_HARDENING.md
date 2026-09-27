# SaaS 9C — Adversarial, Security & Failure Hardening

## Scope and threat model

This pass treats browser input, provider responses, website content, inbound
email, and AI output as untrusted. Supabase remains durable authority; the
Decision Engine decides what, the Orchestrator coordinates, Trigger.dev decides
when/how, and AI remains advisory. The review covered workspace/auth context,
RLS, service-role scoping, security-definer RPCs, decision/orchestration paths,
outbound delivery, ownership, suppression, quota, billing, mailbox/OAuth,
inbound receipts, AI context/output/provider boundaries, triggers, follow-ups,
reactivation, audit, and logging.

The adversarial suite is offline. It uses fake DNS, HTTP, provider outcomes,
and deterministic concurrency models plus source/migration contract checks. It
cannot call live AI, Stripe, Supabase, Trigger.dev, or email providers.

## Findings and fixes

### Tenant isolation and authority

Tenant data is protected by workspace RLS and the workspace-scoped service-role
client. The client structurally injects `workspace_id`, scopes reads/mutations,
rejects cross-workspace writes, and requires workspace-scoped upsert conflict
targets. API workspace and role selection is resolved from live active profile
and membership rows; browser JSON/query/route roles and workspace identifiers
do not grant authority. Platform-admin targeting is explicit and validates that
the workspace exists.

No tenancy or role bypass was found in the reviewed application surface. The
existing final-platform-admin trigger was concurrency-safe. A real race did
exist for final workspace owners: two simultaneous demotions could both observe
two owners before either committed. Migration 19 adds a table-level trigger
with a workspace-keyed transaction advisory lock so update/delete paths cannot
remove the final active owner, including direct future service-role writers.

### AI authority and prompt injection

SaaS 9B's trust-labelled context builder keeps website/email payloads inside a
bounded external-data section. Injection fixtures include system-role claims,
fake XML/JSON/Markdown commands, recipient/workspace substitution, suppression
and policy overrides, credential requests, tool/SQL requests, nested/base64-like
instructions, and token-exhaustion junk. The content remains data and receives
no workspace, role, recipient, sending, suppression, ownership, quota, billing,
or orchestration authority.

Machine-consumed schemas are now strict: unknown authority/tool/SQL fields are
rejected rather than silently carried forward. A 64,000-character raw AI output
ceiling is enforced before structured parsing and for free-text harness output.
The actual send recipient is never accepted from writer output; it is returned
by the final database authority claim from the current lead row.

### SSRF and fetch safety

The agentic contact-search loop previously accepted an absolute model-suggested
URL and fetched it directly. The general research homepage fetch had the same
class of exposure for stored website URLs. Both now use one public HTTP guard:

- HTTP/HTTPS only; URL credentials rejected.
- localhost, `.localhost`, `.local`, metadata hosts, loopback, link-local,
  RFC1918, carrier-grade NAT, reserved/test ranges, unique-local IPv6, and
  link-local IPv6 rejected.
- DNS must resolve exclusively to public addresses.
- every redirect is manually resolved and revalidated; maximum three.
- response body is streamed with a 512 KiB ceiling.
- request timeout is 10 seconds.
- model-suggested contact URLs must remain on the stored business origin.

Residual DNS rebinding risk is discussed below.

### Send safety and delivery uncertainty

Two genuine send-path weaknesses were fixed. First, suppression, ownership, and
workspace status could change after their earlier application check but before
the provider call. Second, the V2 canary mailbox branch occurred before the
shared mailbox sender's old conditional claim.

Migration 19 adds `public.claim_outbound_email_for_send`, a service-role-only
security-definer RPC. It locks the workspace, email intent, lead, and ownership
row; requires an active workspace; requires the exact workspace/email/lead
binding and `pending_send` state; re-resolves and normalizes the current
recipient; rechecks manual/data-quality and delivery suppression; rechecks
active ownership; and atomically moves the intent to `sending`. It returns the
authoritative recipient. Every mailbox path, including canary, now invokes this
claim before quota and provider access and replaces any caller-supplied `to`
value with the returned recipient.

The canary approval envelope remains persisted before provider submission while
the common boundary performs the sole `pending_send -> sending` transition.
Canary remains single-shot (`V2_CANARY_MAX_ATTEMPTS = 1`).

Provider acceptance followed by a lost/ambiguous response remains
`delivery_uncertain`. That state is terminal for automatic execution and is not
eligible for another claim. A successful provider call followed by a database
write failure remains `email_sync_failed`, also excluded from retries. Definite
pre-provider quota failure releases only the matching unresolved claim back to
`pending_send`; the idempotent quota key prevents double charging.

### Replay, idempotency, and concurrency

Durable controls reviewed:

- email intent status plus unique outbound intent constraints and stable
  provider idempotency/message IDs;
- atomic final send claim and terminal uncertain/sync-failed states;
- recipient ownership unique by workspace and normalized address, with an
  advisory transaction lock;
- quota usage event unique by workspace/period/dimension/idempotency key and an
  atomic guarded counter update;
- Stripe event claim keyed by Stripe event ID;
- inbound receipt unique key plus atomic receipt claim;
- OAuth encrypted, expiring, provider/user/workspace-bound state plus an
  HttpOnly same-site fingerprint cookie that is cleared on callback;
- final workspace-owner and platform-admin serialization.

No in-memory mutex is treated as durable authority.

### Suppression and ownership

Email normalization trims and lowercases while preserving plus aliases under
the existing policy. Suppression and ownership remain workspace-scoped. The
new final send claim checks both suppression and ownership while holding the
relevant rows. AI cannot clear either. The same normalized recipient can be
owned independently in different workspaces, but only once within a workspace.

### Quota and entitlements

SaaS 6 remains the only quota system. Consumption is atomic at the limit,
idempotent on retry, fails closed without an entitlement, and supports the
existing unlimited `internal_beta` profile. The outbound email key is the
durable email intent ID; AI keys are stable across provider retries. The final
send authority check occurs before quota consumption. If quota rejects before a
provider call, the matching claim is safely released for later remediation.

### Billing and Stripe

Browser input selects only an allowlisted plan code mapped server-side to a
configured Stripe price. Unknown prices fail closed. Signatures are verified
before event handling; live-mode fixture events are rejected; customer,
subscription, and workspace mappings are checked; duplicate events converge on
the durable event row; canceled/unpaid states do not retain paid entitlements;
and `internal_beta` cannot be replaced by checkout or billing sync. No live
Stripe action was run.

### Mailbox, OAuth, and inbound email

Mailbox rows are workspace-scoped, management is admin-only, expired/revoked
credentials fail through stable provider error categories, and public mailbox
shapes omit encrypted tokens and provider account identifiers. OAuth state is
encrypted, short-lived, PKCE-bound, provider/user/workspace-bound, fingerprinted
in an HttpOnly cookie, and cleared on callback. Wrong providers, users,
workspaces, malformed state, expired state, and replay without the cookie fail.

Inbound payloads remain untrusted. Receipt registration and processing are
idempotent and workspace-scoped. Subject/body content is used only for matching
and deterministic reply classification; it cannot assign roles, workspaces, or
send authority. Unknown/mismatched mailboxes fail closed. Stored error details
are bounded.

### Provider failure behavior

Anthropic, OpenAI, and Gemini disable SDK retry multiplication and use a bounded
four-attempt application retry for their configured transient classes. Timeout,
429, and 5xx/overload behavior is bounded; ordinary 4xx, malformed output,
empty output, and oversized output do not retry as successful work. The central
AI harness has a finite timeout and returns stable error categories.

### Input bounds

Existing pagination, search normalization, import (500 rows), bulk action (200
IDs), regeneration (200 IDs), context (20,000 characters), writer output, and
onboarding/settings bounds were retained. The generic lead deletion input now
caps at 1,000 IDs. Public fetches and raw AI output gained explicit byte/character
ceilings.

### Logging and secret handling

The generic logger previously serialized arbitrary metadata directly. It now
uses the existing bounded observability sanitizer: secret/token/authorization,
prompt/content/body/payload keys are redacted recursively; strings, arrays,
depth, keys, and total metadata bytes are bounded. Log messages redact common
Bearer/key/token/secret forms and are length-bounded. Audit metadata retains its
independent database and application sanitization. The adversarial suite verifies
that representative secrets and bodies do not appear in emitted JSON.

### Security-definer review

The migration corpus was checked for explicit `search_path` on security-definer
functions. Relevant operational RPCs validate service role and workspace
binding, and grants exclude PUBLIC/anon/authenticated where the operation is
service-only. Migration 19 follows the same pattern. Existing RLS was not
weakened and historic migrations were not edited.

## Test command and result

Run:

```text
npm run test:security-adversarial:v2
```

The suite contains 62 adversarial checks, including the 36 requested
minimum outcomes. It also checks redirect/credential/size URL cases, durable
authority source contracts, strict AI schemas, all provider retry boundaries,
logging redaction, security-definer search paths, and final-admin serialization.

The suite also connects only to the fixed isolated-local V2 endpoint at
`127.0.0.1:54322` when it is available. Its database fixtures verify
cross-workspace IDs, suppression/ownership/workspace races, concurrent claims,
terminal delivery uncertainty, and concurrent final-owner demotions, then clean
up. `.env.v2.local` points to a non-local Supabase environment, so the generic
application and performance-reliability mutation suites were not run. No hosted
database was mutated.

## Residual risks and production recommendations

- DNS is validated before each request and redirect, but standard `fetch` does
  not pin the validated address to the connection. A hostile authoritative DNS
  server could attempt rebinding between lookup and connect. Same-origin model
  navigation materially reduces the agentic case. Production egress controls
  or an address-pinning HTTP agent are recommended as defense in depth.
- OAuth replay protection is cookie-bound and provider authorization codes are
  normally single use; there is no separate durable nonce-consumption table.
- External providers without reliable provider-side idempotency cannot prove a
  negative after transport loss. Manual reconciliation of
  `delivery_uncertain` remains required and must never be automated.
- Migration 19 was statically reviewed and type/build tested but was not applied
  to hosted V2 during this task, by design.

No reviewed application-layer issue remains that blocks beta after migration 19
is applied and the deployment smoke checks pass. Until that migration is
deployed, the final send-time race fix is not active and outbound execution
should remain gated.

## Deployment smoke checks

1. Apply migration `00000000000019_security_hardening.sql` through the normal V2
   migration process; do not repair or rewrite migration history.
2. Verify anon/authenticated cannot execute `claim_outbound_email_for_send` and
   service role can execute it only with matching workspace/email/lead rows.
3. With providers mocked or execution gated, verify one of two concurrent claims
   succeeds and the other reports `intent_already_claimed`.
4. Add suppression, change ownership, and suspend the workspace immediately
   before separate claims; each must fail without a provider call or quota event.
5. Verify a quota rejection returns the same intent to `pending_send`, while
   `delivery_uncertain`, `sent`, and `email_sync_failed` never do.
6. Verify canary approval envelope persistence, one provider attempt, and the
   deterministic database recipient on an allowlisted non-delivery fixture.
7. Verify two concurrent attempts to demote the last two owners leave exactly
   one active owner.
8. Run the complete V2 regression and adversarial commands in an isolated local
   V2 environment before enabling any execution gate.
