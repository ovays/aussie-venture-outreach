# SaaS 8: Platform Administration and Audit

## Architecture

SaaS 8 separates browser authority, application authority, and database enforcement:

- Browser routes authenticate the live Supabase user and resolve platform or workspace authority on the server.
- `src/lib/admin` and `src/lib/audit` are server-only data-access modules. Privileged database calls use the service role and always receive an explicit server-resolved workspace and actor.
- Migration 17 supplies service-only mutation/read RPCs, authoritative actor checks, RLS, and an append-only audit ledger.
- The audit ledger is diagnostic history. It is never used as an authorization source.

Platform administration is available under `/dashboard/admin`: Workspaces, Team & Members, Usage & Billing, Audit Log, Data Quality, and AI Analytics. There is no impersonation and no workspace hard-delete operation.

## Audit schema

`public.audit_events` records:

- optional `workspace_id` (`NULL` only for genuine platform events);
- actor user, actor type, and actor role;
- dot-delimited action name;
- target type and optional target identifier;
- result, request identifier, source, sanitized metadata, and creation time.

Action names use lower-case dot notation, such as `workspace.member.role_changed`, `platform.workspace.status_changed`, and `workspace.entitlement.override_set`. Database and TypeScript checks reject malformed action names.

## Append-only design

Authenticated browser roles receive `SELECT` only. They have no direct `INSERT`, `UPDATE`, or `DELETE` privilege and no execute privilege on the writer or administrative RPCs. The service role receives `SELECT`; only the restricted function owner receives `INSERT`, so service callers must use a validated security-definer RPC.

The `audit_events_append_only` trigger rejects every update or delete, including privileged attempts. Audit correction is therefore another event, never an edit. Foreign keys use `ON DELETE SET NULL` so retained history does not block lifecycle cleanup of referenced records.

## Actor identity and authority

Routes never accept actor identity or actor role from JSON, query parameters, or browser workspace fields. They derive the user from the authenticated server session. Workspace routes use `requireApiWorkspaceAdmin`, which resolves active membership from `workspace_members`.

Database functions independently verify:

- `platform_admin` actors are active platform admins in `profiles`;
- workspace `owner` and `admin` actors have that exact active role in the authoritative workspace;
- user audit actors match an active platform or workspace authority record;
- system and service-role actors cannot claim a user identifier or user role.

Platform workspace changes require a platform admin. Service-role functions require an explicit workspace for every workspace mutation.

## Role and membership guardrails

The platform role (`profiles.role = admin`) is separate from workspace roles (`owner`, `admin`, `member`). Browser role strings are allow-listed. Workspace APIs cannot accept or grant `platform_admin`.

- Members cannot call membership administration routes.
- Workspace admins and owners can operate only in the server-resolved workspace.
- Workspace admins cannot create, demote, suspend, or remove owners.
- Mutation RPCs bind the target lookup to both workspace and user, so a membership from another workspace is not a valid target.
- The final active workspace owner cannot be demoted, suspended, or removed.
- The final active platform admin cannot be demoted, deactivated, or deleted.
- The protected seed workspace cannot be suspended or archived.
- Platform admins may administer an explicitly selected existing workspace without becoming a member.

Membership role, status, add, and removal operations write their audit event in the same database transaction as the mutation.

## Metadata sanitization

Metadata is recursively sanitized in both TypeScript and PostgreSQL. Sensitive keys are replaced with `[REDACTED]`, including password, token variants, authorization, cookies, API/client/service-role keys, encryption/private keys, credentials, webhook secrets, and session data.

Generic and provider payload fields (`payload`, request/response bodies, OAuth, Stripe, and email payloads) are also redacted. Metadata is size-bounded before insertion. Entitlement audit mirroring records only the dimension and limit, not operator notes or provider payloads.

Never add passwords, token values, full OAuth/Stripe/email payloads, or secrets under a different metadata name.

## RLS and audit access

RLS is enabled on `audit_events`:

- active platform admins may select all workspace and platform events;
- active workspace owners/admins may select only events whose `workspace_id` matches their membership;
- ordinary workspace members and anonymous users cannot select audit rows;
- no browser write policies exist.

Application audit endpoints reproduce those boundaries. `/api/admin/audit` requires a platform admin. `/api/audit` ignores browser workspace input and uses the authoritative workspace context.

## Workspace administration

The platform directory returns bounded, non-credential fields: workspace identity/status, active member count, stored-lead count, connected-mailbox count, entitlement, and billing state. Workspace detail includes safe profile fields (`id`, email, display name, membership role/status), usage, entitlement, and billing summaries.

Platform workspace APIs support name/status updates and safe membership add, role, status, and removal actions. They do not expose auth credentials, service keys, impersonation, or hard deletion.

## Entitlement override auditing

SaaS 6 remains the mutation authority for entitlement overrides. Migration 17 adds an `AFTER INSERT` trigger on `workspace_entitlement_override_audit` that transactionally mirrors `set` and `clear` rows into the general audit ledger as:

- `workspace.entitlement.override_set`
- `workspace.entitlement.override_cleared`

If the original override transaction rolls back, its general audit event rolls back too.

## Pagination and indexes

Audit reads use a stable `(created_at, id)` keyset cursor ordered descending. The application limit must be 1–100 and the database clamps every request to the same maximum. Invalid cursors fail with HTTP 400.

Indexes cover global, workspace, actor, and action timelines, with `id DESC` as the deterministic tie-breaker.

## Security boundaries

- V1 is not part of this feature and remains read-only.
- Hosted V2 must not receive migration 17 until the documented manual deployment step.
- Service credentials remain server-only.
- Browser workspace identifiers and roles are untrusted.
- Audit content is minimized and sanitized; the ledger is not a payload archive.
- The test command is pinned to PostgreSQL on `127.0.0.1:54322` and performs no provider calls, emails, AI, Finder, Trigger, deployment, or hosted database actions.

## Deployment order

1. Confirm hosted V2 migration history is complete through migration 16 and take the normal database backup/snapshot.
2. Deploy application code only in coordination with the database change; the new routes depend on migration 17 RPCs and tables.
3. Apply migration 17 manually as described below. Do not use `db push` or repair migration history.
4. Verify table, trigger, RLS policies, function grants, and the four audit timeline indexes.
5. Run application smoke checks as a platform admin and workspace admin.

## Manual hosted migration 17

Migration 17 transfers public functions to `reachagent_function_owner`. The golden baseline revoked that role's `CREATE` privilege on `public`, and PostgreSQL requires the new function owner to have `CREATE` on the containing schema during ownership transfer. A temporary grant is therefore required.

Run as the approved privileged hosted V2 database operator, never against V1:

```sql
GRANT CREATE ON SCHEMA public TO reachagent_function_owner;

BEGIN;
-- Execute the exact contents of:
-- supabase-v2/migrations/00000000000017_admin_audit.sql
COMMIT;

REVOKE CREATE ON SCHEMA public FROM reachagent_function_owner;
```

With `psql`, use `ON_ERROR_STOP=1` and include the migration file inside the transaction. If any statement fails, issue `ROLLBACK`, then revoke the temporary schema grant. Do not mark migration 17 applied unless the entire transaction committed and verification succeeded.

After commit, verify at minimum:

```sql
SELECT to_regclass('public.audit_events');
SELECT tgname FROM pg_trigger WHERE tgname IN ('audit_events_append_only', 'mirror_override_audit_to_audit_events');
SELECT indexname FROM pg_indexes WHERE tablename = 'audit_events' ORDER BY indexname;
SELECT policyname, cmd FROM pg_policies WHERE tablename = 'audit_events' ORDER BY policyname;
SELECT has_schema_privilege('reachagent_function_owner', 'public', 'CREATE'); -- must be false
```

## Rollback considerations

Prefer an application rollback that stops using the new routes while retaining migration 17 and its audit history. Dropping the ledger would destroy security records and is not an ordinary rollback.

If schema rollback is exceptionally approved, first export/retain `audit_events` according to the data-retention policy, remove dependent application code, and use a separately reviewed manual rollback transaction. Never update/delete individual audit rows or weaken RLS to make rollback easier. Ensure any temporary `CREATE` grant and temporary role membership are revoked after both successful and failed attempts.
