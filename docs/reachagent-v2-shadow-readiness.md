# ReachAgent V2 shadow readiness

Implementation date: 15 September 2026 (Australia/Sydney)
Status: ready for the next controlled environment phase; no production access or deployment performed

The pre-change audit is preserved in `docs/reachagent-v2-shadow-readiness-baseline.md`. Prompt 13 added no database migration and did not edit any V2 migration.

## Outcome

ReachAgent now has a dedicated, bounded V1-intent versus V2-intent comparison path. It cannot dispatch an executor, acquire a recipient or orchestration lock, call AI/providers, run Finder, or mutate operational tables. A runtime read-only Supabase facade blocks `insert`, `upsert`, `update`, `delete`, and `rpc` before request construction. Prompt 10 observability is the only optional write capability and defaults off.

The former daily-pipeline shadow hook was removed. The operational daily task ignores shadow as execution permission and remains the legacy path unless a later phase explicitly enables the Orchestrator. A separate `v2-shadow-comparison` Trigger task exists without a schedule.

## Precise shadow definition

Shadow may:

- select at most 100 explicit or bounded/cohort lead IDs;
- load set-based Decision Context and operational facts;
- run the pure Decision Engine;
- derive deterministic legacy intended action without executing V1;
- classify and aggregate the difference;
- optionally write sanitized Prompt 10 workflow/step telemetry;
- return/print a no-write report.

Shadow may not:

- update leads or follow-up/reactivation state;
- insert/update email intents;
- claim recipients or distributed locks;
- generate template/personalized content through AI;
- call Research AI, Writer AI, Resend, Hostinger mutation, Google, or Outscraper;
- change suppression or data-quality state;
- invoke any executor or operational agent;
- ingest Finder results.

## Safety model

`assertShadowSafeExecution()` is the single fail-closed assertion used by evaluator/runtime entry points. It requires:

```text
ORCHESTRATOR_SHADOW=true
ORCHESTRATOR_ENABLED=false
OUTREACH_SEND_ENABLED=false
HOSTINGER_MUTATIONS_ENABLED=false
FINDER_SCHEDULE_ENABLED=false
```

Both Orchestrator flags true is rejected. `ORCHESTRATOR_SHADOW=false` is the kill switch. The operational Orchestrator runtime rejects `shadow` requests, so callers cannot reach its executor registry or database lock under a shadow label.

`createReadOnlySupabaseClient()` wraps the data client and blocks all mutation/RPC builder methods at runtime. Shadow code receives only this client plus pure evaluation dependencies; it never receives executors, provider clients, or AI capabilities. This is defense in depth over environment gates.

`SHADOW_OBSERVABILITY_WRITE_ENABLED=false` is the default. With it false, no observer can be injected and evaluation is pure read/report. With it true, the runtime uses Prompt 10 `workflow_runs` (`workflow_type=shadow_comparison`) and one sanitized `shadow_decision_comparison` step per lead. It stores IDs, actions/reason, classification, safe fact names, cohort/source, status/category disposition, and correlation ID—never bodies, prompts, raw rows/provider responses, or secrets.

## Read-only loading and sample selection

The context loader accepts no more than 100 unique IDs. It preloads the complete sample once using at most six bounded, set-based calls:

1. leads with embedded deals and open data-quality flags;
2. relevant email stages only;
3. eight Decision Engine settings;
4. bounded initial-mode snapshots;
5. category templates when category IDs exist;
6. recipient ownership when normalized addresses exist.

No full lead row, email body, or full history is selected. The runtime then evaluates the in-memory context map with concurrency default four, clamped to ten. Results preserve input order and isolate individual failures.

Supported selectors are repeatable `--lead-id`, `--status`, `--recent-days`, and a required `--limit` for cohort/recent selection. Ordering is deterministic (`updated_at DESC`, then `id ASC`). `--classification` filters displayed results after bounded evaluation. There is no select-all default.

## Comparison contract and legacy adapter

Each result has this stable shape:

```text
leadId
legacyAction
v2Action
classification
reason { v2ReasonCode, comparisonNote }
relevantFacts { safe names and compact stage/status facts }
timestamp
source / sampleCohort / correlationId
```

Canonical classifications are:

- `MATCH`
- `EXPECTED_V2_CONSOLIDATION`
- `BUG_IN_OLD_LOGIC`
- `BUG_IN_NEW_ENGINE`
- `PRODUCT_DECISION_REQUIRED`

The former Prompt 11 wording `BUG_IN_ORCHESTRATOR` is an alias of `BUG_IN_NEW_ENGINE`; it is never emitted as a sixth value.

`deriveLegacyIntendedAction()` is a narrow adapter over current status/mode/template facts, suppression/duplicate/ownership/manual facts, reply disposition, shared follow-up eligibility, reactivation timing, and existing stage state. It does not execute V1, call agents, or duplicate the full V1 pipeline.

## Approved difference register

| ID | Legacy behavior | V2 behavior | Classification | Approved | Why | Test |
|---|---|---|---|---:|---|---|
| SD-001 | Template-ready new lead routes through Researcher. | `GENERATE_INITIAL`; deterministic template path uses no Research AI. | `EXPECTED_V2_CONSOLIDATION` | yes | Prompt 9 removed unnecessary research when all recipient/template facts exist. | `template-ready-new` in shadow-readiness suite |
| SD-002 | Lifecycle UI may name a future action before due. | Executable engine returns `WAIT`. | `EXPECTED_V2_CONSOLIDATION` | yes | Display projection is not executable eligibility. | Decision Engine lifecycle projection test |
| SD-003 | Legacy batch agents repeat routing gates. | Decision Engine centralizes routing; exact services retain send-time rechecks. | `EXPECTED_V2_CONSOLIDATION` | yes | Prompts 11–12 approved this consolidation. | Agent consolidation suite |

No difference becomes expected merely because it exists. Unregistered differences remain `PRODUCT_DECISION_REQUIRED` unless a reviewed invariant proves an old/new bug.

## Readiness thresholds

For supported synthetic paths:

```text
BUG_IN_NEW_ENGINE = 0
unresolved execution-critical PRODUCT_DECISION_REQUIRED = 0
MATCH + approved EXPECTED_V2_CONSOLIDATION = 100%
evaluation errors = 0
executor / AI / provider / operational DB mutation calls = 0
```

No production rollout percentage is invented before production evidence exists.

## Representative synthetic evidence

The suite evaluates 29 cases across:

- NEW: template-ready, template missing researchable data, personalized missing research, personalized researched;
- EMAIL_READY: initial pending, uncertain send, suppressed;
- CONTACTED: FU not due, FU1/FU2/FU3 due, all FUs complete, reactivation not due/due;
- REPLIES: interested, unsubscribe, out-of-office, unclear;
- TERMINAL: dead, closed, closed_manual, interested, negotiating;
- DATA QUALITY: duplicate, missing email, invalid template, manual override, manual source, missing category.

Result: 29/29 supported, 28 matches, one registered consolidation, zero new-engine bugs, zero unresolved product decisions, zero errors. The final regression sweep measured 5.985 ms for the local pure comparison. This is local evidence, not an SLA.

A no-write CLI run over one local V2 synthetic lead selected/evaluated one match, used the six-call ceiling and fetched one row, and reported providers/mutations disabled. No observability row was written.

## V1 data compatibility report

This is a schema-contract assessment only; V1 production was not queried.

| Fact | Source | Disposition |
|---|---|---|
| canonical statuses | `leads.status` | supported; an unknown value fails that lead only |
| nullable category | `category_id/category_name` | supported with manual review for template comparison |
| initial/FU states | bounded `emails` facts | supported |
| reactivation | `reactivation_sent_at` + settings | supported |
| suppression | lead suppression fields/address list | supported |
| recipient ownership | bounded ownership rows | supported without claims |
| duplicates | embedded open data-quality flags | supported without consolidation |
| mode snapshot | bounded activity event | supported |
| templates/settings | category template + eight keys | supported; invalid/missing template reviews |
| manual cases | `source=manual`, `closed_manual`, explicit override context | deterministic manual/stop outcome |
| replies | receipt/status facts | safe handoff; no message-body classification is inferred |

### Null-category rule

`category_id` remains nullable. No count from an earlier audit is reused as current truth, and no backfill occurs. Personalized leads can evaluate normally from their other facts. A template-mode lead with missing/unknown category has `categoryDisposition=missing_or_unknown` and returns manual review for content generation; it is not silently excluded from the report or mutated.

## Environment matrix

| Environment | Required posture | Result |
|---|---|---|
| Local V2 synthetic/data | shadow true; execution/send/Finder/Hostinger false; writes false by default; loopback URL | safe and verified |
| Separate V2 deployment + V2 DB | same gates; explicit V2 project ref; dedicated read key preferred | prepared, not deployed |
| V1 production read-only tiny sample | explicit production-read target, env acknowledgement, command acknowledgement, dedicated read credential, all mutation/send gates false | prepared only; not executed |
| V1 production execution | any V2 execution/send permission | prohibited in Prompt 13 |

### Future production-read acknowledgement

Both are required:

```text
V2_SHADOW_ALLOW_PRODUCTION_READS=true
--acknowledge-production-read
```

The command target must be `v1-production-readonly`; the read URL/key must be supplied as `V2_SHADOW_SUPABASE_URL` and `V2_SHADOW_SUPABASE_READ_KEY`. A remote URL cannot masquerade as `local-v2`, and the known production ref cannot masquerade as `v2`. A production-read acknowledgement never changes execution, provider, Finder, Hostinger, or observability-write flags.

For the safest future arrangement, use a dedicated Postgres/API role with SELECT only on the exact context tables/views. Do not use the V1 service-role key. Keep RLS enabled unless a narrow reviewed view/role is required. If observability writes are desired, point ordinary V2 environment variables at the isolated V2 observability database while the `V2_SHADOW_*` variables remain the separate read-only V1 source. Otherwise keep no-write mode.

No credentials or grants were added to the repository.

## Manual command

Local example:

```powershell
$env:ORCHESTRATOR_SHADOW='true'
npm run shadow:v2 -- --target local-v2 --status contacted --limit 50 --recent-days 30
```

Explicit leads can use repeated/comma-separated `--lead-id`; `--classification BUG_IN_NEW_ENGINE` filters display. The command prints target URL origin, write/provider/mutation posture, selected count, context metrics, mutation-facade audit, summary, and ordered results. It rejects missing target, missing bound, more than 100 leads, invalid statuses/dates/concurrency, a false kill switch, unsafe gates, or incomplete production acknowledgement.

## Trigger strategy

`trigger/v2-shadow-comparison.ts` is a dedicated task with queue concurrency one and maximum duration 300 seconds. It has no cron, Finder import, operational agent import, or executor. Future invocation requires `TRIGGER_JOBS_ENABLED=true` plus the independent shadow assertion. It was not deployed, scheduled, or run.

The daily pipeline no longer contains a shadow comparison section. With Orchestrator execution false, V1 continues independently. Shadow failure cannot skip, block, or alter V1 work.

## Kill switch and failure behavior

Set `ORCHESTRATOR_SHADOW=false` or disable/invoke no dedicated task. The evaluator fails before reading. Existing V1 tasks do not depend on shadow success, comparison classification, observability availability, or report completion.

## Controlled rollout plan (not executed)

1. Stage 0 — local synthetic/no-write shadow (completed).
2. Stage 1 — isolated V2 DB with anonymized or explicit sample data.
3. Stage 2 — read-only V1 production shadow over tiny explicit IDs.
4. Stage 3 — bounded read-only lifecycle cohorts.
5. Stage 4 — separate V2 deployment against separate V2 DB.
6. Stage 5 — Aussie Venture canary on test leads/non-send workflow.
7. Stage 6 — controlled real-send canary.
8. Stage 7 — expand V2 execution using evidence and kill switches.
9. Stage 8 — retire legacy only after proven parity and rollback readiness.

No stage may jump from local tests to real sending.

## Separate V2 deployment prerequisites

Before Stage 4, create (in a later approved phase):

- separate Vercel project and V2 URL;
- separate V2 Supabase project/database;
- separate Trigger.dev V2 project;
- separate environment variables and credentials;
- `ORCHESTRATOR_ENABLED=false`, `ORCHESTRATOR_SHADOW=false` initially;
- `OUTREACH_SEND_ENABLED=false`, `TRIGGER_JOBS_ENABLED=false`, `FINDER_SCHEDULE_ENABLED=false`, `HOSTINGER_MUTATIONS_ENABLED=false`;
- production Supabase and Trigger denylists retained;
- no V1 credentials in the V2 deployment unless a later reviewed read-only shadow stage explicitly supplies the dedicated read credential.

No Vercel/Trigger/Supabase project or deployment was created here.

## Trigger Node runtime

Installed Trigger.dev 4.5.16 types accept `runtime: "node-24"`. `trigger.config.ts` now declares it. This was a config-only branch/workspace change; no Trigger deployment occurred.

## Verification results

Passed locally:

- `test:shadow-readiness:v2`;
- `test:agent-consolidation:v2`;
- `test:orchestrator:v2`;
- `test:observability:v2` (isolated local V2 writes only);
- `test:decision-engine:v2`;
- `test:performance-reliability:v2`;
- `test:application:v2`;
- template-mode AI boundaries;
- follow-up eligibility against local V2 (read-only, zero eligible rows);
- reactivation eligibility (15 checks);
- Resend send idempotency, duplicate protection, and follow-up selection;
- duplicate follow-up prevention;
- webhook signature/handling (47 handling checks);
- Hostinger webhook/inbound synthetic tests with React server conditions;
- Finder category/suburb cooldown and local category-selection dry run with provider calls disabled;
- `typecheck:v2`;
- `build:v2` on Next.js 16.2.4 (45 generated pages/routes).

SQL suites were not run because no DB/schema change was made. V2 migrations remain exactly `00000000000000`, `00000000000001`, and `00000000000002`.

### Non-blocking pre-existing test fixture issue

`scripts/test-finder-suburb-priorities.ts` fails because tracked V1 migration `supabase/migrations/041_category_suburb_priorities.sql` contains only the two bytes `cl`. Git history shows it was introduced in that state. Prompt 13 did not rewrite frozen V1 migration history; live-schema and V2-baseline evidence contain the expected table. This is not a shadow-path regression, but the repository fixture should be repaired from authoritative V1 migration provenance before using that particular legacy test as release evidence.

`scripts/test-finder-logic.ts` is not a static/synthetic test: it attempts a live Outscraper request. An attempted audit invocation was blocked by the sandbox (`EACCES`) before a connection/response and was not retried. It is excluded from safe Prompt 13 verification. No Finder agent, ingestion, or production database operation ran.

## Production safety record

Production application deployments/changes: 0
Production database/schema changes: 0
Production data changes: 0
Production deployments: 0
Production database reads: 0
Production sends: 0
Production Hostinger mutations: 0
Production Trigger runs: 0
Production Finder runs/ingestion: 0

No real shadow traffic, Aussie Venture migration, category backfill, Reply Agent, workspace/multi-tenancy, billing, onboarding, V1 retirement, or V2 deployment was started.
