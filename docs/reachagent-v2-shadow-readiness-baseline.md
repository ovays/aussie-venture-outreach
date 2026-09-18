# ReachAgent V2 shadow-readiness pre-change baseline

Audit date: 15 September 2026 (Australia/Sydney)
Scope: repository and local V2 configuration only; no production read, write, run, send, or deployment was performed.

This file records the state before Prompt 13 implementation. The repository had a dirty worktree containing the earlier V2 work; those changes are treated as the working baseline and are not reverted.

## Current gates

| Gate | Current reader / enforcement | Default | Protects today | Audit finding |
|---|---|---:|---|---|
| `ORCHESTRATOR_ENABLED` | `readOrchestratorFlags()` and daily pipeline ownership branch | false when absent | Whether the V2 Orchestrator replaces the legacy Researcher/Writer/Sender/Follow-up/Reactivation stages | False-by-default, but it is not a provider or mutation guard. |
| `ORCHESTRATOR_SHADOW` | `readOrchestratorFlags()` and per-lead request | false when absent | Stops executor lookup/call after one Decision Engine evaluation | Executor calls are skipped, but current orchestration still writes workflow telemetry and acquires/releases a database lock. It is not read-only. |
| `OUTREACH_SEND_ENABLED` | `assertOutreachSendEnabled()` in the shared Resend transport for V2 runtime | false in validated V2 environment and example | V2 Resend delivery | Strong final transport gate for V2 only. It does not itself prevent pre-send database mutations. |
| `TRIGGER_JOBS_ENABLED` | scheduled tasks and manual daily-pipeline route for V2 runtime | false in validated V2 environment and example | Trigger task execution/dispatch | Blocks V2 jobs when false. It is necessarily true for any Trigger-hosted shadow task, so it cannot be the shadow mutation boundary. |
| `FINDER_SCHEDULE_ENABLED` | start of daily pipeline for V2 runtime | false in validated V2 environment and example | Scheduled Finder execution | The daily task requires it before reaching the current shadow section; therefore that task cannot safely be used for isolated shadow evaluation. |
| `HOSTINGER_MUTATIONS_ENABLED` | Hostinger mutation assertion | false in validated V2 environment and example | V2 Hostinger mutation calls | False-by-default. Shadow must avoid importing/invoking mutation paths independently of this gate. |

`src/lib/env.ts` supplies false defaults for all six gates, but `readOrchestratorFlags()` reads `process.env` directly. Missing values still resolve false. `.env.v2.example` names all six false. The local `.env.v2.local` names the four provider/job gates false and omits both Orchestrator flags; the omission currently resolves to false.

## Current integration and execution paths

- `trigger/daily-pipeline.ts` checks both `TRIGGER_JOBS_ENABLED` and `FINDER_SCHEDULE_ENABLED`, acquires a whole-pipeline database lock, runs Finder, then runs a bounded Orchestrator batch when either Orchestrator flag is true.
- With `ORCHESTRATOR_SHADOW=true`, `orchestratorOwnsExecution` is false. The legacy Researcher, Writer, Sender, Follow-up, and Reactivation stages therefore continue after the comparison. This preserves V1 behavior but makes the daily task unsuitable as a side-effect-free shadow entry point; Finder and legacy stages can mutate/call providers.
- The manual `POST /api/pipeline/run` path checks `TRIGGER_JOBS_ENABLED` and triggers that same daily task. It is not a shadow-specific entry point.
- `runConfiguredLeadBatch()` creates a service-role client, loads bounded context, and calls the ordinary Orchestrator with `shadow=true`.
- `orchestrateLead()` creates/updates workflow telemetry and acquires/releases `distributed_locks` before its shadow short-circuit. It does not call an action executor in shadow, but its lock and observability operations are database mutations.
- The production executor registry is constructed for shadow dependencies even though executor lookup is not reached. This is avoidable coupling and makes accidental future invocation harder to reason about.
- Candidate selection is limited to 100 and ordered, while the context loader rejects more than 100 IDs and uses five or six set-based queries. Existing orchestration batch concurrency defaults to four and is clamped to ten.

## Supabase, Trigger, provider, and environment guards

- `assertV2SupabaseTarget()` requires `NEXT_PUBLIC_REACHAGENT_RUNTIME=v2`, permits localhost, requires an explicit matching V2 project reference for another Supabase host, and unconditionally refuses the known V1 production Supabase project.
- Both browser/server Supabase factories call this guard. The service factory uses the service-role key; there is no dedicated least-privileged shadow/read-only client.
- Consequently, future acknowledged V1 production reads are not currently representable. A narrowly scoped shadow target assertion and a separately supplied read credential are required; production-write permission must remain impossible.
- `trigger.config.ts` requires the V2 runtime marker and an explicit V2 Trigger project reference, and refuses the known production Trigger project. No task is deployed by this audit.
- Installed Trigger.dev 4.5.16 types explicitly accept `runtime: "node-24"`. The current config omits `runtime`, so it uses the SDK/project default rather than explicitly selecting Node 24.
- Shared Resend transport asserts `OUTREACH_SEND_ENABLED` under V2. Hostinger and Finder scheduling have their own V2 assertions. Research/Writer provider boundaries are not globally shadow-aware; safety currently depends on the Orchestrator never invoking them.
- Next.js 16.2.4 local documentation confirms that non-`NEXT_PUBLIC_` variables remain server-side, public-prefixed values are build-time inlined, and sensitive modules should use a server-only boundary. A shadow acknowledgement/write flag must therefore be server-only and non-public.

## Observability and data compatibility baseline

- Prompt 10 provides `workflow_runs` and `workflow_steps`; metadata is depth/size bounded and redacts prompts, bodies, payloads, secrets, credentials, authorization, cookies, and tokens.
- Current shadow output records engine action/reason, legacy action/classification/note, and decision input names. It does not provide a reusable comparison result, batch summary, sample cohort, or no-write reporter.
- The comparison vocabulary is already `MATCH`, `EXPECTED_V2_CONSOLIDATION`, `BUG_IN_OLD_LOGIC`, `BUG_IN_NEW_ENGINE`, and `PRODUCT_DECISION_REQUIRED`. Prompt 11 documentation mentions `BUG_IN_ORCHESTRATOR`; this must become a documented alias of canonical `BUG_IN_NEW_ENGINE`, not a silently emitted sixth value.
- The legacy adapter is a small deterministic function over Decision Context and existing follow-up eligibility. It does not execute V1, but needs to be formalized/exported and covered against the active lifecycle decisions.
- The context loader reads bounded lead fields, delivery suppression, email stages, settings, mode snapshots, deals, and category templates. It does not currently model recipient ownership, explicit duplicate facts, reply classification detail, or stored manual overrides.
- `category_id` is nullable in the loader. Missing categories skip the template query and currently become `template.available=false`; handling is deterministic but not explicitly reported as a compatibility/content-comparison limitation.
- No current compatibility report verifies that a V1 schema/data source supplies every selected V2 field/table/status. No production query may be used to create that report in this phase.

## Dangerous combinations

| Combination | Risk / disposition |
|---|---|
| `ORCHESTRATOR_SHADOW=true`, `TRIGGER_JOBS_ENABLED=true`, `FINDER_SCHEDULE_ENABLED=true` on the daily task | Dangerous: Finder and legacy operational agents run; not an isolated shadow run. |
| `ORCHESTRATOR_ENABLED=true`, `ORCHESTRATOR_SHADOW=false` | V2 execution path; prohibited in Prompt 13 even if send gates are false because research/content and operational DB mutation can occur. |
| `ORCHESTRATOR_ENABLED=true`, `ORCHESTRATOR_SHADOW=true` | Shadow currently wins executor routing, but telemetry/locks mutate and the daily legacy path remains live. Treat as invalid rather than relying on precedence. |
| Any shadow run with `OUTREACH_SEND_ENABLED=true` or `HOSTINGER_MUTATIONS_ENABLED=true` | Invalid defense-in-depth posture even if executors are expected not to run. |
| Production-like Supabase URL with a service-role credential | Prohibited for shadow. The current general service client is over-privileged for future production reads. |
| Production-read acknowledgement interpreted as write/send permission | Explicitly invalid; acknowledgement may authorize reads only and must never relax any other gate. |

## Safe combinations before Prompt 13 implementation

| Target | Gate state | Current status |
|---|---|---|
| Local V2, no orchestration | all six gates false | Safe and current local default. |
| Local V2, direct pure Decision Engine tests over synthetic contexts | all six gates false | Safe; no database/provider dependency. |
| Local V2, current Orchestrator shadow | shadow true, enabled/send/Hostinger/Finder false | Executor-safe but not read-only because telemetry and lock rows mutate. Not sufficient for Prompt 13. |
| Any production-like target | any combination | Not approved and currently hard-denied by the V2 target guard. |

## Remaining rollout gaps to close

1. Add a single explicit shadow-safe runtime assertion that rejects execution-enabled, provider-enabled, mutation-enabled, unacknowledged production-like, and invalid target combinations.
2. Create a shadow evaluator that depends only on bounded reads, the pure Decision Engine, deterministic legacy adapter, and an optional observability sink; do not acquire locks or construct executors.
3. Default observability persistence off, so a read-only credential and pure report mode are supported.
4. Add bounded explicit/cohort/recent/deterministic selection, maximum 100, limited concurrency, stable ordering, per-lead failure isolation, and aggregate summaries.
5. Add a non-interactive manual CLI requiring an explicit target and bounded selector. Production-like reads must additionally require both a server-only environment acknowledgement and a command acknowledgement.
6. Keep shadow out of the daily operational task. If Trigger preparation is added, use a dedicated unscheduled task with its own queue/kill switch and no Finder or operational agents.
7. Provide a shadow-specific client/credential strategy. Local/V2 may use the existing client; eventual V1 production shadow should use a separately supplied least-privileged read credential. Observability, if enabled, should target an isolated V2 store rather than the read-only V1 connection.
8. Add compatibility checks, explicit null-category disposition, synthetic cohort coverage, expected-difference register, zero-side-effect instrumentation, and rollout thresholds.
9. Set Trigger config to `runtime: "node-24"` only as a config-only local change; do not deploy.

Production application changes during this audit: 0.
Production database changes during this audit: 0.
Production data changes during this audit: 0.
Production deployments/reads/sends/Trigger/Finder/Hostinger runs during this audit: 0.
