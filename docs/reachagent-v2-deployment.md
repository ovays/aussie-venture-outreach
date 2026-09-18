# ReachAgent V2 deployment preparation

## Outcome and topology

Local deployment preparation is complete; remote isolation is not yet created or verified. The intended boundary is one repository with the existing V1 production branch/project/database/Trigger credentials untouched and branch `reachagent-v2-application` connected only to a new V2 Vercel project, new V2 Supabase database/auth tenant, new V2 Trigger.dev project, and V2-only variables. There is no shared operational database, Trigger project, production deployment, auth population, or credential set.

Audit details are in `docs/reachagent-v2-deployment-baseline.md`; exact operator steps and rollback are in `docs/reachagent-v2-deployment-runbook.md`.

## Implemented guards

`validateV2DeploymentEnvironment()` now runs from `next.config.ts`. It requires a V2 deployment marker, V2 runtime, matching non-V1 Supabase URL/ref, Node 24, safe gates, and no shadow credentials or V1 aliases. Remote modes additionally require Supabase keys, a distinct Trigger ref/secret, exact branch intent, V2 Vercel project marker, and non-local app URL. Vercel's branch is checked when its system value is present. Errors name variables or target classes but never values.

`trigger.config.ts` requires an explicit `TRIGGER_V2_PROJECT_REF`, rejects the known V1 project, rejects `TRIGGER_SECRET_KEY_PROD`, and pins Node 24. No tasks were deployed. The two schedule-bearing tasks remain source-only and must not be deployed during first smoke.

Next.js `.env.local` merging was addressed by explicitly blanking V1 aliases and provider credentials in the ignored local V2 file, documenting blank values in `.env.v2.example`, and making V1 aliases build-fatal. Removed/blocked fallbacks: V2 can no longer accept `TRIGGER_SECRET_KEY_PROD`, `TRIGGER_PROJECT_ID`, production/V1 Supabase aliases, `ADMIN_EMAIL`, `ENABLE_SENDER`, `ENABLE_FOLLOWUP`, `TRIGGER_ACCESS_TOKEN`, or `RESEND_API_KEY_Gmail`. Application Trigger calls use only `TRIGGER_SECRET_KEY`; it is accepted only alongside a verified distinct V2 project ref.

## Environment matrix

| Class | Required initially | Initial value/policy |
|---|---|---|
| App identity | `REACHAGENT_ENV`, runtime, branch, Vercel project, app URL | Explicit V2 staging values |
| Supabase | URL, anon key, service-role key, V2 ref | New V2 project only; service key server-only |
| Trigger | V2 ref and secret | New V2 project only; tasks not deployed |
| Execution | eight gate variables | Every value exactly `false` |
| Shadow | no read URL/key | Production reads and observability writes false |
| AI | none | Leave Anthropic/OpenAI/Gemini unset |
| Outbound email | none | Leave Resend unset; send gate false is the server backstop |
| Hostinger | none | Leave mailbox/token/webhook unset; mutations false |
| Finder | none | Leave Maps/Outscraper unset; jobs and schedule false |
| Bootstrap | email/password | Operator shell only, then clear |
| Hosted DB apply | DB URL | Operator shell only, never app/Vercel env |

## Hosted database, auth, and synthetic data

The hosted-compatible golden baseline hash is `797D845B5505D7BA6B5AFE856582D4D08B9919614BBD791E507C81A9235C24C4`, replacing `80266A4A68FE173F721B3E00BB7C2B31A54CF8FF02D78EBC4FF88CC40A898A39`. Hosted smoke proved that Supabase's managed `auth` schema does not allow the project database login to grant usage to the dedicated NOLOGIN function owner. The affected routines now read the same JWT claim settings used by managed `auth.uid()` and `auth.role()` directly, preserving behavior without a managed-schema dependency. The earlier hosted-compatible ownership, platform schema, temporary membership, and explicit ACL controls remain unchanged. There is no product table, column, constraint, policy, or behavior change.

Hosted-like non-superuser testing proved that `00000000000001` also needs the same temporary membership to replace its existing private NOLOGIN-owned report function. Its approved SHA-256 is now `75DA9844FB2BAAFC3CF1E46AE8E85E792F256CCD22909FB759D5090DF95D25D1`, replacing `62C97F96799A01B5245456C00A530DA2B1631C0D10489F61C987E395B4901D14`; no function body changed.
Hosted verification then proved that `00000000000002` must include `service_role` in its workflow-table revoke before replaying the existing explicit service allowlist. Its approved SHA-256 is `CB07CE3BA5D469B8F47B168923D16FC7BEE8CC9208609A04C33E9534BD2E544B`, replacing `685CF5F20DBF61320772909EA55F6994E7D697ADCCECDC5A24A49C4CB56D5083`; intended privileges and all functional definitions are unchanged. Hosted application runs each file in a single transaction so a failed file cannot leave another partial catalog.

`scripts/apply-v2-hosted-baseline.ps1` validates target identity, empty schema, exact three-file inventory, golden/performance/observability hashes, and false gates before calling `psql`. `scripts/verify-v2-hosted-db.ps1` runs the read-only hosted catalog/security assertions and creates a report. Neither script links a Supabase project or touches migrations `001`–`054`.

`scripts/bootstrap-v2-admin.ts` is remote-capable, idempotent, V2-target guarded, server-side, and independent of `ADMIN_EMAIL`. `scripts/seed-v2-test-data.ts` is idempotent/resettable, uses fixed marked IDs and `example.test`, and calls no external provider. The local seed passed twice. Hosted database application and verification completed on 2026-09-16; hosted admin bootstrap and seed remain pending.

### Prompt 14 hosted database result (2026-09-16)

The verified target identity hash was `048f449a766f121c`, distinct from the known V1 project. Preflight confirmed all eight gates false, zero public objects, and the safe/idempotent pre-existing `reachagent_function_owner` role. After locally proving hosted-compatible ownership and ACL behavior under a non-superuser login named `postgres`, migrations `00000000000000`, `00000000000001`, and `00000000000002` were applied. Each file is now applied transactionally.

Hosted Supabase default ACLs initially injected broad direct grants on new public objects. A reviewed ACL-only transaction removed those grants, replayed the migrations' explicit allowlists, revoked its temporary owner membership, and removed broad future defaults for application-owned `postgres` objects. Managed `supabase_admin` defaults and platform ownership were not changed.

Final read-only verification passed with: 27 tables and 27 RLS-enabled tables, 49 policies, 49 public and 10 private functions, 15 safe SECURITY DEFINER functions, 96 indexes, 125 constraints, 15 ReachAgent/Auth triggers, both workflow tables with zero rows, the ten canonical lead statuses, zero unrelated V1 tables, zero anon table grants, zero unsafe owner memberships, and all public tables empty. The report is `docs/reachagent-v2-hosted-db-verification.txt`.

### Prompt 14 hosted application result (2026-09-16)

The isolated Vercel project `reachagent-v2-staging` was configured with exactly the 19 approved V2 Production variables and deployed from the `reachagent-v2-application` checkout. The Vercel build completed on Node 24 / Next.js 16.2.4 and the production alias is `https://reachagent-v2-staging.vercel.app`. No Trigger tasks or schedules were deployed.

The disposable `example.test` admin bootstrap and fixed synthetic seed both passed. Authenticated hosted smoke returned 200 for the dashboard, leads, lifecycle, pipeline, email log, email report page, settings, AI settings, admin data quality, and admin pages. Read-only health, auth, leads, lifecycle, settings, categories, cities, and email-log APIs returned 200. The mailbox API correctly returned 503 `Mailbox not configured`. Deployment diagnostics matched the expected V2 Supabase, Trigger, branch, and Vercel project identities, with all eight gates false; the repository hosted-safety checker passed.

Hosted smoke exposed a managed-Supabase compatibility issue: SECURITY DEFINER routines owned by `reachagent_function_owner` could not call managed `auth.uid()`/`auth.role()` because the project login cannot grant that NOLOGIN role access to the managed `auth` schema. An atomic 13-function compatibility transaction replaced only those calls with the same JWT-claim expressions used by the managed helpers, removed its temporary role/schema privileges, and changed no data, policies, tables, or managed ACLs. The golden baseline now contains the equivalent definitions. Post-seed hosted verification passed with 5 synthetic leads, 3 synthetic emails, 49 policies, 96 indexes, and exactly the disposable admin plus approved synthetic fixtures as the only public data.

## Runtime/provider/browser safety

No boot, login, dashboard, or lead-list module starts a task or AI call. Manual pipeline dispatch requires `TRIGGER_JOBS_ENABLED=true`; the daily task additionally requires Finder scheduling true before Finder. Shared outbound delivery checks `OUTREACH_SEND_ENABLED` before Resend construction/calls, covering initial, bulk, follow-up, reactivation, digest, resend/retry paths; the direct test-email SDK path performs the same check before SDK access. Tests prove false gates throw before those paths.

Hostinger currently implements metadata reads/searches, not delete/move/mark mutations. The mutation gate remains false, inbound Trigger dispatch is jobs-gated, and no mailbox credentials are present. Email report now degrades to `Mailbox not configured` instead of attempting a provider call or crashing. Finder has no automatic path with jobs/schedule false; provider keys are absent. AI generation/research is explicit-action only and provider credentials are absent.

Unsafe controls may remain visible in the first UI, but server checks are authoritative for provider/task execution. Ordinary lifecycle/category/settings mutations affect only the isolated V2 database. Regenerate/retry/provider-test actions must not be used during first smoke; without credentials they fail closed rather than falling back to V1.

The authenticated dynamic diagnostics endpoint is `/api/admin/deployment-diagnostics`. It exposes only app intent, branch/project label, hashed project refs, short commit, Node version, and eight booleans. The automated hosted checker requires an operator-supplied authenticated cookie and exposes/logs neither cookie nor secrets.

## Source-control and local verification

Checkpoint audited: branch `reachagent-v2-application`, commit `f5f60bd6243846795b5911cc936dd1ad092a4a9d`. No merge, tag, commit, or remote push/deploy was performed. The existing dirty Prompt 8–13 worktree was preserved.

Passed locally on 2026-09-15:

- `test:deployment-safety:v2`
- `test:shadow-readiness:v2`
- `test:agent-consolidation:v2`
- `test:orchestrator:v2`
- `test:observability:v2`
- `test:decision-engine:v2`
- `test:performance-reliability:v2`
- `test:application:v2`
- template-mode AI boundaries
- Resend idempotency and duplicate protection
- Resend webhook signature/handling and synthetic Hostinger inbound
- `typecheck:v2`
- `build:v2` on Next.js 16.2.4 / Node 24.13.1
- synthetic seed twice (idempotency)
- hosted catalog/security verification SQL executed read-only against the isolated local V2 catalog (`27` tables, `49` policies, `96` indexes)

Authenticated `test:pages:v2` stopped before requests because V2 test-admin credentials were not supplied. Hosted database catalog/RLS/ACL verification is complete. Hosted auth-user behavior, UI/API/browser smoke, hosted app diagnostics, Trigger/Vercel inspection, and deployed URL checks remain pending.

## Outstanding manual actions

Continue only with the next reviewed Prompt 14 checkpoint: configure/deploy the isolated V2 application resources as applicable, bootstrap a test admin, seed synthetic data, and run hosted/authenticated smoke. Exact steps are in the runbook. Do not connect providers, deploy Trigger schedules, import real data, or enable any gate.

## Production impact and rollback

V1 application changes: 0. V1 database changes: 0. V1 data changes: 0. V1 deployments: 0. V1 Trigger changes: 0. V1 Supabase changes: 0. V1 Vercel changes: 0. Emails sent: 0. Finder runs: 0. Hostinger mutations: 0. Rollback is deletion/disablement of V2-only resources; no V1 database rollback is necessary.
