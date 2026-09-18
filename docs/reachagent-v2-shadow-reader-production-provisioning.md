# Prompt 15 production isolation V2 provisioning

Date: 17 September 2026 (Australia/Sydney)

Result: **PROMPT 15 PRODUCTION ISOLATION V2 BLOCKED**

No Prompt 15 production object or credential was created. No real business row
was read, and the real 100-lead comparison did not start.

## V2 artifact correction

Before touching production, the production SQL and rollback artifacts were
updated from the rejected `security_invoker` design to the locally rehearsed
two-role model:

- external JWT role `reachagent_prompt15_shadow_reader` receives only schema
  usage and SELECT on the seven shadow views;
- `reachagent_prompt15_shadow_view_owner` receives the exact 38 underlying
  column SELECT grants and the nine Prompt 15 SELECT policies;
- the seven ordinary views use `security_barrier=true`, are owned by the view
  owner, and do not use `security_invoker=true`;
- rollback removes both roles as well as policies, schema/views, Data API
  exposure, dedicated key, and local credentials.

The corrected provisioning artifact was not executed because the read-only
production preflight found a hard blocker.

## Read-only production preflight

- V1 production is PostgreSQL 17.6.
- All 38 required columns and types match the rehearsal.
- RLS is enabled on all nine required base tables.
- All nine required base tables are owned by `postgres`.
- `USAGE ON SCHEMA public TO PUBLIC` is present, as expected and unchanged.
- `PUBLIC` has zero public base-table SELECT grants, zero public column SELECT
  grants, and zero sequence privileges.
- Neither Prompt 15 role, the shadow schema, Prompt 15 policies, the dedicated
  key, nor Data API shadow-schema exposure existed.
- Data API exposed schemas remained `public, graphql_public`.

## Blocking incompatibility

Production has 54 `public` routines with `EXECUTE` granted to PostgreSQL
`PUBLIC`. Because public-schema `USAGE` must remain granted to `PUBLIC`, both
new roles would inherit those routine privileges immediately when created.
That violates the required zero-routine-privilege boundary for both the reader
and view owner.

PostgreSQL has no per-role negative grant that can override a privilege granted
to `PUBLIC`. Removing those routine grants would modify existing V1 grants and
is outside the authorized safety boundary. The V2 roles therefore cannot be
created under the current production ACL baseline.

## No-change verification

The safety snapshot was repeated after the blocked preflight and all hashes
matched exactly:

- existing V1 access: `780462a255cd53eb2081799ca3882779777391abd75bd22204ec8867b2ff2c1b`
- existing non-Prompt15 policies: `1d181041b48a5d4172fc916f260feb1e8e2546741013f3fbf80fffdaa34f2c48`
- application roles/memberships: `f4b6169b92fc4fc0d32c50c205b72e5d9a0c976e433656309473214965bd0a4d`

Final Prompt 15 state: reader roles 0, view-owner roles 0, schemas 0,
views 0, policies 0, authenticator memberships 0, dedicated keys 0. All local
Prompt 15 URL/key/JWT/schema values are empty and
`V2_SHADOW_ALLOW_PRODUCTION_READS=false` remains persistent.

Impact counters remain zero: V1 data mutations, application deployments,
Trigger deployments, sends, AI calls, Finder runs, Hostinger mutations,
existing V1 grant removals, existing policy modifications, and application-role
changes.

The real ≤100-lead comparison cannot proceed.
