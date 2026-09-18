# Prompt 15 isolation model V2 local rehearsal

Date: 16 September 2026 (Australia/Sydney)

Result: **PROMPT 15 ISOLATION MODEL V2 LOCAL PASS**

No V1 production connection, query, credential, database change, hosted
configuration change, or business-row read occurred.

## Environment and model

- Disposable PostgreSQL 18.6 on `127.0.0.1:55432`
- Official PostgREST 16.3 on `127.0.0.1:55433`
- V1-compatible fixture tables, RLS, application roles, sensitive columns, a
  mutating RPC, and a sequence
- Rehearsal definition: `scripts/prompt15-shadow-reader-local.sql`
- Automated SQL, catalog, API, credential, and client proof:
  `scripts/test-prompt15-shadow-reader.ts`

The local fixture deliberately grants `USAGE ON SCHEMA public TO PUBLIC`, which
matches the production condition that blocked V1. That grant remains present.
It was not revoked or masked.

V2 uses two custom roles:

1. `reachagent_prompt15_shadow_reader` is the external JWT role. It has schema
   usage and `SELECT` on exactly seven shadow views. It has zero table-level or
   column-level `SELECT` privileges on every `public` base table.
2. `reachagent_prompt15_shadow_view_owner` owns the seven ordinary views. It is
   not a base-table owner and receives 38 exact column-level `SELECT` grants on
   the nine required tables. Role-specific `FOR SELECT` policies apply to it.

The views use PostgreSQL's ordinary owner-execution semantics and
`security_barrier=true`. None uses `security_invoker=true`. The view owner has
no shadow-schema `USAGE`, no application-role membership, and no ability to be
assumed by the external reader or `authenticator`.

Both custom roles are `NOLOGIN`, `NOSUPERUSER`, `NOINHERIT`, `NOCREATEDB`,
`NOCREATEROLE`, and `NOBYPASSRLS`.

## Privilege proof

Catalog assertions and negative execution tests proved:

- `PUBLIC` has `USAGE` on `public`, and both custom roles therefore have
  effective public-schema usage.
- The external reader has zero table-level and zero column-level base-table
  `SELECT` privileges.
- Direct reader queries against `leads`, `emails`, `settings`, `activity_log`,
  and every other fixture base table fail with `permission denied for table`.
- The view owner owns zero base tables and all seven shadow views.
- The view owner has only the exact 38 required underlying column `SELECT`
  grants; excluded columns such as `emails.subject` and `deals.deal_value` are
  denied.
- Both roles have zero public base-table write privileges, zero sequence
  privileges, zero executable public/shadow routines, and no membership in
  `anon`, `authenticated`, or `service_role`.
- Reader and view-owner attempts to update, delete, truncate, claim, lock, or
  advance a sequence fail. The reader also has zero write grants on the shadow
  views, and the client mutation facade blocks insert, upsert, update, delete,
  and RPC before request construction.

The view owner necessarily owns the seven view objects, but it has no
underlying DML privilege; attempted view/base writes fail. Ownership does not
confer any base-table ownership or privilege.

## RLS proof

- Every required base table has RLS enabled.
- Policies are granted only to the dedicated view-owner role.
- Direct execution as the view owner returns one allowed email and hides the
  disallowed draft fixture.
- The external reader receives that same one-row result through `email_facts`
  despite having no base privilege, demonstrating owner execution through the
  view.
- After `SET row_security=off`, the view owner's query fails with `query would
  be affected by row-level security`; it does not reveal the hidden row.
- The owner is `NOBYPASSRLS`, is not a base-table owner, and has no membership
  in either application role that could add a permissive policy.

## Seven-view and Decision Engine proof

PostgREST loaded exactly seven relations and zero RPCs. The custom-role JWT read
all seven surfaces:

| View | Exposed derived facts |
|---|---|
| `lead_facts` | ID, update time, status, category ID, source, reactivation time, field-presence booleans, suppression boolean, recipient-ownership state |
| `email_facts` | Lead ID, stage type/status, sent/replied/created timestamps |
| `decision_settings` | Eight allow-listed Decision Engine setting key/value pairs |
| `mode_snapshots` | Lead ID, derived initial-email mode, timestamp |
| `duplicate_flags` | Duplicate lead ID only |
| `deal_leads` | Deal lead ID only |
| `category_initial_template_facts` | Category ID, template-ready boolean, required-placeholder names |

The test reconstructed a complete `LeadDecisionContext` from only these facts
and successfully evaluated the Decision Engine.

No surface contains lead or normalized email, business name, phone, address,
raw city, website, email subject/body, template subject/body, arbitrary
metadata, prompts, AI content, provider identifiers, or credentials. The API
proof checked representative secret fixture values and rejected requests for
nonexistent sensitive columns.

## Client and compatibility proof

- Dedicated publishable key format in `apikey`
- Separate one-hour custom-role bearer JWT; tokens over two hours rejected
- Role fixed to `reachagent_prompt15_shadow_reader`
- Schema fixed to `reachagent_prompt15_shadow`
- GET/HEAD-only network guard
- Read-only mutation/RPC facade
- `service_role`, `sb_secret`, and reused-key/token forms rejected
- RPC endpoint returned 404; PostgREST reported zero RPCs in its schema cache
- Existing fixture behavior stayed intact: `authenticated` retained its
  read/write behavior, `service_role` retained its bypass behavior, and `anon`
  still could not read base tables

Final automated result:

```json
{
  "status": "PASS",
  "publicSchemaUsageThroughPublic": true,
  "readerUnderlyingTablePrivileges": 0,
  "viewOwnerUnderlyingWritePrivileges": 0,
  "viewOwnerUnderlyingColumnSelectPrivileges": 38,
  "viewReads": 7,
  "sqlWriteAndPrivilegeDenials": 22,
  "rlsChecks": 6,
  "clientMutationBlocks": 5,
  "postgrestRpcStatus": 404,
  "reconstructedDecisionContext": true
}
```

## Production conclusion

The V2 design is safe to provision in V1 production under the observed
`PUBLIC` schema-usage baseline, subject to a production change window that
first validates the authoritative schema/owners and then uses a zero-row
privilege/identity denial gate before any business-row request. The old
security-invoker V1 provisioning model must not be reused.

This rehearsal did not provision, query, or otherwise touch production. It did
not revoke or modify any existing V1 grant or policy.
