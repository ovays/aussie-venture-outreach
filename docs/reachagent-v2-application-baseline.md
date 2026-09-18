# ReachAgent V2 application baseline

Baseline date: 15 September 2026 (Australia/Sydney)

Status: implementation and verification in progress. This document records the
isolation decision and compatibility audit before application code changes.

## Isolation model (decision recorded before implementation)

ReachAgent V2 will use one application codebase on a dedicated
`reachagent-v2-application` Git branch, with a V2-only runtime profile and the
already-separated `supabase-v2` Supabase root.

- Production V1 remains on its existing branch/runtime and retains the frozen
  `supabase/migrations/001_*` through `054_*` history.
- V2 reuses and minimally refactors the existing application. There is no copied
  repository or permanently forked UI/application tree.
- V2 database commands must use `supabase-v2/config.toml`; only
  `supabase-v2/migrations/00000000000000_reachagent_v2_golden_baseline.sql` is in
  that migration root.
- V2 app commands load an uncommitted `.env.v2.local` profile. The committed
  example contains names and safe defaults only, never credentials.
- Runtime guards must require an explicit V2 marker and reject the known
  production Supabase project. Local is the default V2 database target; a remote
  non-production V2 project must be explicitly identified.
- Trigger.dev/outreach entry points must fail closed in V2 unless an explicit send
  or job-enable flag is set. The V2 example keeps all such flags disabled.
- Fixtures are disposable and synthetic. No production business data is part of
  this baseline.

This is the safest practical structure because code fixes remain mergeable into a
single application while database migration roots, credentials, commands, and
side-effect permissions remain independently gated.

## Pre-change application compatibility audit

The initial source audit found these V2 incompatibilities. They are recorded
before broad code modification, as required.

1. `src/lib/lead-status.ts` is already intended as the application source of
   truth, but still includes `closed_won`; several UI, reporting, duplicate/data
   quality, dashboard, lifecycle, and test call sites also embed it. V2 accepts
   `closed` instead and rejects `closed_won`.
2. No current application writer was found setting `leads.status = 'dm_queued'`;
   DM queue state is stored in `dm_queue.status`. Historical/schema references
   must not be promoted into the V2 lead lifecycle.
3. The Data Quality route passes `p_actor_id` to both redesigned RPCs. V2 accepts
   `remove_data_quality_emails(uuid[])` and
   `set_data_quality_flag_status(text,text,uuid[],text,text)`, derives the actor
   from `auth.uid()`, and rejects the legacy argument.
4. `src/lib/auth.ts` can create a missing profile as admin by matching
   `ADMIN_EMAIL`. V2 requires every automatic/new-user profile to be `member`;
   disposable admin elevation must be an explicit server-side bootstrap step.
5. Supabase browser, SSR, service-role, and proxy clients currently consume the
   generic environment variables directly with no V2 target assertion.
6. The repository has no generated `Database` type wired into its Supabase client
   factories. V2 types should be generated from the isolated baseline.
7. Send and job paths can use Resend, Hostinger, and production Trigger.dev keys;
   notably the pipeline route explicitly prefers `TRIGGER_SECRET_KEY_PROD`.
   V2 must deny these paths before any external mutation.
8. V2 has stricter RLS, no anon access, and narrower SECURITY DEFINER execution.
   Main pages require authenticated fixtures; admin configuration/data-quality
   operations require an admin fixture, while ordinary member writes must be
   checked against the approved policy matrix.
9. `city_suburbs.priority` is now `NOT NULL` with a 1-10 check. Existing UI/API
   validation must be checked for null, default, and range behavior.
10. `leads.category_id` remains nullable in this parity baseline, but Finder and
    creation paths must preserve a known category ID where available. The future
    `NOT NULL` migration is explicitly out of scope.
11. Normalization triggers may change stored lead email/domain/name values; CRUD
    smoke tests must assert the V2 stored result instead of assuming raw input is
    preserved byte-for-byte.

## Implementation and verification record

## Environment protection

`.env.v2.example` is the committed V2-only template. `.env.v2.local` is ignored
and holds only local Supabase credentials on the development machine. V2 commands
load it before Next.js; per the installed Next.js 16 documentation, process
environment values take precedence over `.env.local`.

`assertV2SupabaseTarget()` is called from Next configuration (startup/build), the
browser client, SSR/server client, service-role helper, and proxy. It requires the
V2 runtime marker, refuses the known production project reference, accepts local
hosts, and requires an explicit matching project reference for any remote V2
target. A default `npm run build` using the repository's existing V1 `.env.local`
failed closed before compilation; `npm run build:v2` passed.

## Isolated database connection model

Supabase CLI requires its config directory to be named `supabase`. The committed
`scripts/prepare-v2-supabase.mjs` therefore creates ignored
`.v2-local/supabase` as a directory link to the authoritative `supabase-v2`
directory. It does not copy migrations and cannot expose `supabase/migrations`.

The verified dump contains owner statements that Supabase CLI's restricted
migration runner cannot execute. `supabase-v2/config.toml` disables automatic CLI
migration/seed replay. On a fresh local platform, `npm run db:v2:apply`:

1. requires the exact local container `supabase_db_reachagent-v2-local`;
2. requires exactly one V2 migration and its verified SHA-256;
3. refuses a non-empty public schema;
4. removes Supabase-local broad default API grants (platform preparation only);
5. applies the one unchanged golden baseline as local `supabase_admin`.

The local platform preparation is not an application/schema migration. It is
needed because Supabase local pre-grants public objects to API roles, whereas the
verified baseline starts from clean platform ACLs and installs its explicit grant
matrix. No V1 migration is discoverable or replayed.

Verified local connection surfaces:

- browser/auth client: authenticated member and admin sessions in the synthetic
  application smoke test;
- SSR/server client and auth/profile lookup: authenticated page requests through
  the running Next proxy;
- service-role helper: status-count RPC plus fixture/admin bootstrap operations;
- runtime target: local API at `127.0.0.1`, never the production project.

## Generated types

`src/types/database.ts` was generated from the running isolated V2 schema with
`npm run types:v2` (1,552 lines at baseline creation). The redesigned Data Quality
RPC callers use the generated `Database` function argument types directly.

Parameterizing every Supabase client with the generated type exposed a wider set
of existing nullable-column assumptions in sender, tracker, settings, reporting,
and dynamic update payloads. That full nullability refactor was deliberately not
performed in this parity prompt. The generated type remains authoritative and is
used at the changed RPC boundary; general clients remain unparameterized pending
a separately approved reliability/type-hardening pass.

## Compatibility changes

- `src/lib/lead-status.ts` now defines exactly the ordered V2 statuses:
  `new`, `researched`, `email_ready`, `contacted`, `replied`, `interested`,
  `negotiating`, `closed`, `closed_manual`, `dead`.
- Leads filters derive their choices/labels from that source. Dashboard/pipeline
  stage grouping, Data Quality protection, duplicate selection, utilities, and
  lifecycle verification no longer treat `closed_won` as a stored status.
- Both lead PATCH APIs validate status with `z.enum(ALL_STATUSES)`; the list API
  rejects unknown status filters. Synthetic DB tests proved `interested` works and
  `closed_won`/`dm_queued` are rejected.
- `dm_queue.status` remains independent. No application writer sets
  `leads.status='dm_queued'`.
- Existing suburb priority clamping/default behavior is compatible with V2's
  `NOT NULL DEFAULT 1 CHECK (priority BETWEEN 1 AND 10)` contract.
- Normalized lead fields were verified through stored synthetic results.

## RPC caller changes

The Data Quality action route no longer sends caller-controlled `p_actor_id`.
It calls and type-checks exactly:

- `remove_data_quality_emails(p_lead_ids)`;
- `set_data_quality_flag_status(p_issue_type, p_normalized_email, p_lead_ids,
  p_status, p_resolution_reason)`.

Authenticated synthetic admin calls resolved/reopened a flag and removed an
invalid email successfully. The database continues to derive the actor from
`auth.uid()` and allows audited service-role system calls.

## Auth test setup

The application missing-profile fallback now always inserts `role='member'`;
`ADMIN_EMAIL` elevation was removed. The database Auth trigger was also verified
to ignore `role=admin` client metadata. `scripts/bootstrap-v2-admin.ts` is a
local-host-only, service-role procedure: it creates a disposable member first,
then explicitly elevates that profile server-side. The page-test admin was deleted
after testing.

## Trigger.dev and send safeguards

The V2 template defaults these independent gates to false:

- `OUTREACH_SEND_ENABLED`
- `TRIGGER_JOBS_ENABLED`
- `FINDER_SCHEDULE_ENABLED`
- `HOSTINGER_MUTATIONS_ENABLED`

All Resend delivery paths converge on guarded `sendEmail`; the separate test-send
route is also guarded. Manual pipeline dispatch, scheduled daily pipeline, digest,
and Hostinger inbound task dispatch/run are gated. V2 no longer prefers
`TRIGGER_SECRET_KEY_PROD`. `trigger.config.ts` also requires an explicit V2
project reference and rejects the known production Trigger.dev project, so the
V2 branch cannot deploy its schedules there. The smoke test proved Resend and
Trigger paths throw before network access. No real email, Hostinger mutation,
production Finder, or follow-up dispatch occurred.

## Test results

| Check | Result |
|---|---|
| Golden migration SHA-256 at this historical checkpoint | PASS: `C193213A560FB3BB29CB0ECAC2324F4D7B4151F480E8C1FD676143435BC9BDA2` (superseded on 2026-09-16 by the hosted-compatible ownership-only revision recorded in the golden verification document) |
| V2 migration files | PASS: exactly 1 |
| Local public tables / RLS | PASS: 25 / 25 enabled |
| Unrelated WhatsApp/bookings tables | PASS: 0 |
| Local anon schema access | PASS: denied |
| Local negative security suite | PASS |
| Exact clean catalog/behavior suite | PASS: `VERIFY_CATALOG_AND_BEHAVIOR_PASS` |
| Exact clean negative security suite | PASS: `VERIFY_SECURITY_NEGATIVE_PASS` |
| Generated types | PASS |
| V2 TypeScript typecheck | PASS |
| Next.js production build | PASS: 45 routes/pages |
| Synthetic application smoke | PASS |
| Authenticated main-page HTTP smoke | PASS: 10/10 returned 200 |
| UI/source regressions | PASS: app shell, responsive pages, Leads suppression, Settings suburb priority, Data Quality P1/P2, category/template storage/management, global search, Email Report UI, AI configuration, destructive admin routes |
| Existing Finder suburb-priority test | V1 issue: FAIL because frozen `supabase/migrations/041_*` is the known literal `cl`; the V2 baseline priority DB checks passed |
| Lint | Not configured in `package.json`; no lint command exists |

Authenticated page smoke covered Dashboard, Leads, Lifecycle, Pipeline, Email Log,
Email Report, Settings/categories/templates, AI settings, Data Quality, and Admin.
Finder, Researcher, and Writer are pipeline agents rather than standalone routes in
the current product; their code compiled, while actual scheduled/external agent
execution remained intentionally blocked. Email Report rendered without production
mailbox credentials. The in-app browser service was unavailable, so page smoke was
performed as real authenticated HTTP rendering through Next.js rather than visual
click automation.

## Unresolved issues

- Full generated-client nullability adoption is deferred to the approved
  performance/reliability phase; generated RPC contracts are already enforced.
- No AI provider/model seed exists by design, so live AI generation was not run.
- No production mailbox credentials were used, so Email Report external mailbox
  retrieval was not exercised.
- The frozen V1 migration-041 source test remains red for the already documented
  V1 artifact defect; it is not a V2 regression and must not be repaired by
  changing V1 history.

These limitations do not block the isolated V2 parity baseline: the application,
database, auth, main routes, synthetic CRUD, lifecycle, RPCs, and safety gates all
passed without production access or external sends.
