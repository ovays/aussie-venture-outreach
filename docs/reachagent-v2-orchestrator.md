# ReachAgent V2 deterministic Orchestrator foundation

Completed: 15 September 2026 (Australia/Sydney)

Scope: isolated V2 branch and local/synthetic V2 environment only. No production application, database, data, deployment, Trigger execution, Finder schedule, Hostinger mutation, or real email send was changed by this implementation. No database migration was added or edited.

## Pre-change coordination audit

The required audit was completed before implementation in `docs/reachagent-v2-orchestrator-baseline.md`. The active legacy order is Finder → Researcher → Writer → Sender → Follow-up → Reactivation inside one Trigger.dev scheduled task. The audit records every coordination source, its state assumptions, retry boundary, side effects, duplicated sequencing, and disposition.

The principal finding was that Decision Engine eligibility had already begun replacing per-agent routing, while durable execution safety remained correctly embedded in the services: initial-generation lock, sender quota lock, recipient claim, durable outbound intent, provider idempotency, send-time suppression/state checks, and email-sync recovery. The Orchestrator coordinates these services; it does not absorb their rules.

## Architecture

The implemented ownership boundary is:

`Trigger.dev (WHEN/HOW) → Orchestrator (coordinate) → Decision Engine (WHAT) → executor/service (perform) → Supabase (durable state) → Observability (record)`

The Orchestrator is ordinary deterministic TypeScript. It has no model, prompt, tool loop, planner, arbitrary DAG, or LLM routing. Finder remains upstream because no lead-scoped Decision Context exists before discovery.

Implementation files:

- `src/domain/orchestrator/types.ts`: request, result, executor, dependency, status, and stop contracts.
- `executor-map.ts`: the one explicit action-to-executor registry.
- `state-fingerprint.ts`: compact decision-relevant progress identity.
- `orchestrate-lead.ts`: bounded load → decide → execute → reload loop.
- `executors.ts`: exact-lead adapters around existing research, initial router, outbound intent, follow-up, reactivation-template, delivery, claims, and observability services.
- `batch.ts`: bounded, failure-isolated worker pool.
- `flags.ts`: false-by-default V2 gates.
- `runtime.ts`: server-side Supabase/Observability/lock composition and bounded selection.
- `index.ts`: the single server-side entry surface.

## Request and result contracts

The normalized request is intentionally lead-specific:

```ts
interface OrchestrationRequest {
  workflowType: 'lead_lifecycle'
  leadId: string
  source: string
  triggerRunId?: string
  parentRunId?: string
  correlationId?: string
  maxIterations?: number
  attempt?: number
  shadow?: boolean
}
```

`requestedAction` is deliberately absent. Current manual endpoints carry explicit operator semantics that are not equivalent to automatic progression; accepting an override here would weaken Decision Engine authority. `runLeadOrchestration()` is the reusable server-side entry point for a future compatibility wrapper after those semantics are approved.

The result includes lead and workflow-run IDs, stable orchestration status, final Decision Engine action/reason, every executed action/outcome, iteration count, stop cause, and retryability. Stable stop causes are `WAIT`, `STOP`, `MANUAL_REVIEW`, `HANDOFF_REPLY`, `TERMINAL_STATE`, `MAX_ITERATIONS`, `EXECUTOR_FAILED`, `NO_STATE_CHANGE`, `LOOP_GUARD`, `UNSUPPORTED_ACTION`, `CONCURRENT_EXECUTION`, `LEAD_NOT_FOUND`, and `SHADOW`.

The normalized executor result is only `outcome`, `changedState`, optional `retryable`, and a small sanitized detail record. Existing agent return types are adapted rather than replaced.

## Central action → executor map

| Decision Engine action | Orchestrator behavior |
|---|---|
| `RESEARCH` | Exact-lead Research adapter using `researchOneLead`; template mode uses contact-discovery-only purpose, personalized mode uses full personalization. |
| `GENERATE_INITIAL` | Exact-lead Initial Content adapter using the existing central `routeInitialEmail`; template rendering or AI selection stays in that service. |
| `SEND_INITIAL` | Exact pending initial intent; executor retains system gate, sender quota lock, quotas, recipient claim, suppression recheck, stable email-row idempotency, provider call, sync recovery, and contacted transition. |
| `SEND_FOLLOWUP_1/2/3` | One Follow-up adapter maps the returned action to exactly one type and calls existing `sendFollowUp`; it never invokes the batch “run everything” agent. |
| `REACTIVATE` | Exact-lead Reactivation adapter retains quota lock, recipient/suppression checks, stored template service, durable outbound intent, stable provider identity, and `reactivation_sent_at`. |
| `MARK_DEAD` | Atomic deterministic lifecycle transition constrained to the context's current status. |
| `HANDLE_REPLY` | Stop with `HANDOFF_REPLY`; Tracker/inbound remains authoritative and no reply text is generated. |
| `WAIT` | Stop waiting. |
| `STOP` | Stop; terminal/active-deal reasons are reported as `TERMINAL_STATE`. |
| `MANUAL_REVIEW` | Stop waiting for an operator. |

The map contains no eligibility, timing, suppression, duplication, or mailbox policy. Those facts are evaluated by the Decision Engine or rechecked by the responsible executor.

## Re-evaluation and loop safety

Each iteration loads durable Decision Context, invokes `decideNextAction`, records the decision, dispatches at most the exact mapped executor, and only continues after the executor reports a meaningful state change. The next action is never inferred from the executor type or previous result.

The default maximum is six actions, enough for the longest current same-instant progression (`RESEARCH → GENERATE_INITIAL → SEND_INITIAL`, then normally `WAIT`) with headroom. Caller values are clamped to ten. Execution stops immediately on waiting, stop, manual/reply handoff, failure, unsupported action, missing lead, no state change, repeated action/reason/fingerprint, or maximum iterations.

The compact fingerprint covers status, email, duplicate/suppression/deal facts, mode, research/template readiness, summarized email stages, reply, reactivation, and manual override. It excludes complete rows, volatile timestamps such as `asOf`, and unrelated metadata. An unchanged executor result stops as `NO_STATE_CHANGE`; a repeated decision over the same fingerprint stops as `LOOP_GUARD`.

## Concurrency and replay safety

Each lead execution acquires `orchestrator:lead:<leadId>` through the existing database-backed fenced lock with a 30-minute stale-owner TTL. It is a short database claim row, not a long database transaction; no transaction is held over AI/provider work. A competing execution records a skipped run with `CONCURRENT_EXECUTION`.

Outbound adapters additionally share the existing `sender_agent` lock so their quota check-and-send section cannot race the legacy Sender. This also serializes Reactivation's previously Trigger-only quota assumption. Existing recipient claims and unique/durable email intents remain authoritative.

On Trigger replay, context is loaded again. Completed research/content changes the next Decision Engine action; pending email content is reused; initial/follow-up/reactivation delivery uses the durable email UUID for provider idempotency; `sent` and `email_sync_failed` block repeat delivery; provider-uncertain initial intent remains pending. The Orchestrator adds no second idempotency ledger.

## Workflow paths

- Template: a template-ready new lead returns `GENERATE_INITIAL` directly, so Research AI is not called; after durable content it reloads to `SEND_INITIAL`, then reloads to `WAIT`.
- Template missing facts: the Decision Engine alone may return `RESEARCH`; the executor limits this to contact discovery. Invalid template or unavailable non-researchable values stops at manual review.
- Personalized: `new → RESEARCH → reload → GENERATE_INITIAL → reload → SEND_INITIAL → reload → WAIT` when each durable mutation succeeds.
- Follow-up: Trigger's bounded check causes orchestration; Decision Engine chooses exactly FU1, FU2, FU3, or WAIT. The adapter preserves generation, send-time rechecks, ownership, quotas, intent, and provider idempotency.
- Reactivation: Trigger causes a check; Decision Engine chooses WAIT, REACTIVATE, or MARK_DEAD. Timing never appears in Orchestrator code.
- Reply: deterministic Tracker receipt/matching remains independent; `HANDLE_REPLY` is only a handoff stop. Reply Agent remains deferred.

## Trigger.dev and Finder boundaries

`trigger/daily-pipeline.ts` still owns cron, Australia/Sydney schedule, task queue concurrency 1, maximum duration, Trigger retries/attempt metadata, events, and the whole-run lock. Finder still runs first and performs discovery/ingestion. The Orchestrator never schedules Trigger or queries an unbounded lead population.

Prompt 13 removed shadow comparison from this operational task. `ORCHESTRATOR_SHADOW` does not cause daily comparison; the dedicated unscheduled `v2-shadow-comparison` task owns that capability without Finder or legacy operational agents. With enabled true and shadow false, the bounded Orchestrator batch owns lead progression and the legacy Researcher/Writer/Sender/Follow-up/Reactivation parent steps are recorded as skipped. The existing manual pipeline API still triggers only the operational daily task.

## Flags and shadow safety

`.env.v2.example` and the validated server environment define:

```text
ORCHESTRATOR_ENABLED=false
ORCHESTRATOR_SHADOW=false
```

Prompt 13 treats both flags true as invalid. Runtime operational Orchestrator entry points reject shadow requests and direct callers to `evaluateLeadShadow()`. The dedicated evaluator has no executor, lock, AI, provider, Finder, or operational mutation capability; its optional Prompt 10 observability writes default off.

Existing false-by-default V2 gates remain unchanged: `OUTREACH_SEND_ENABLED`, `TRIGGER_JOBS_ENABLED`, `FINDER_SCHEDULE_ENABLED`, and `HOSTINGER_MUTATIONS_ENABLED`.

## Observability

Every lead orchestration creates a Prompt 10 `workflow_runs` row with source, lead, Trigger run, parent run, correlation, attempt, shadow flag, maximum iterations, completion status, stop reason, duration, and retryability. Every decision is a `workflow_steps` decision step with the canonical action/reason and input keys. Every executor is a separate step with iteration, outcome, changed-state, and normalized failure.

Shadow decision output also contains the existing Decision Engine legacy comparison action, classification, and note. No second logger or schema was added. AI/provider work invoked by existing services retains AsyncLocalStorage correlation where available.

## Bounded batch and performance evidence

`orchestrateLeadBatch` rejects more than 100 requests, clamps worker concurrency to 1–10, defaults to four, preserves result order, and converts one lead's thrown failure into that lead's failed result. The scheduler supplies IDs; the helper does not query leads. Runtime selection is one ordered limited query.

The initial contexts for a runtime batch are loaded once with the existing set-based Decision Context loader and seeded into each lead loop, avoiding an N+1 first load. Only successful actions cause an exact-lead reload. No full table, complete history snapshot, or unbounded `Promise.all` was introduced.

The synthetic harness measured 100 pure representative decisions in 0.76 ms on this local run. This is evidence of coordination overhead only, not an SLA. Database/provider duration remains dominant and is bounded by the existing services and Trigger maximum duration.

## Legacy comparison

| Representative difference | Classification | Treatment |
|---|---|---|
| Personalized new/researched/email-ready/contacted path | `MATCH` | Same business progression, now re-evaluated from durable state per lead. |
| Template-ready new lead skips Researcher | `EXPECTED_V2_CONSOLIDATION` | Prompt 9 intended behavior; no unnecessary Research AI. |
| UI lifecycle may label future reactivation while engine returns WAIT | `EXPECTED_V2_CONSOLIDATION` | Executable eligibility remains unchanged; display projection remains legacy. |
| Legacy agents still contain batch selection and some decision gates | `EXPECTED_V2_CONSOLIDATION` | Retained behind false-by-default compatibility path; Decision Engine is authoritative in enabled path. |
| Explicit manual bulk/resend/mark-sent sequencing | `PRODUCT_DECISION_REQUIRED` | Preserved; not silently reinterpreted as automatic workflow. |

No observed synthetic case was classified `BUG_IN_NEW_ENGINE`. `BUG_IN_ORCHESTRATOR` is retained only as a documented alias of the canonical `BUG_IN_NEW_ENGINE` vocabulary.

## Test matrix and verification

`scripts/test-v2-orchestrator.ts` covers template-ready, template research, template manual review, generated-then-sent, full personalized progression, each follow-up, not-due/already-sent behavior, reactivation not-due/due/already-sent/mark-dead, duplicate/suppressed/missing-email/uncertain/terminal/active/manual/unsubscribe safety, reply handoff, no state change, repeated decision, maximum iterations, thrown executor, replay after research/content/provider acceptance, same-lead contention, shadow side-effect count zero, explicit map coverage, fingerprint stability, bounded batch concurrency, batch rejection, and pure overhead.

Regression results are recorded in the completion handoff. Database schema behavior was not changed, so no `00000000000003_*` migration was necessary; the three existing V2 migrations were not edited.

## Remaining legacy sequencing and deferred items

- Legacy batch agents remain intact and default-active for safe rollout.
- Explicit manual lead operations remain compatibility endpoints; their override semantics require product approval before routing through automatic orchestration.
- The lifecycle/dashboard SQL projections remain read models, not routing authorities.
- Agent consolidation, Reply Agent, workspaces/multi-tenancy, OAuth, billing, onboarding, V2 deployment, and V1 retirement remain out of scope.
