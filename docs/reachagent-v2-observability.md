# ReachAgent V2 observability foundation

Implementation date: 15 September 2026 (Australia/Sydney)

Status: READY in the isolated V2 environment. Production was not changed, deployed, queried for mutation, or used for sends/jobs.

The pre-implementation inventory is in `docs/reachagent-v2-observability-baseline.md`. Observability records what happened; it never decides what should happen and is not authoritative for current business state.

## Architecture

`workflow_runs` is one logical execution. `workflow_steps` is a meaningful operation inside it. The daily Trigger task uses one `daily_pipeline` run and six agent steps because those agents execute serially inside one Trigger run and are not independently retried tasks. The separately retryable Hostinger Trigger task uses an `inbound_reply_processing` run with a provider-event step. If a future stage becomes its own Trigger task, it should become a child run using `parent_run_id`, not both a child run and a duplicate parent step.

High-value coverage in this phase:

- Daily pipeline: parent run plus Finder, Researcher, Writer, Sender, Follow-up, and Reactivation steps; non-fatal discovery-stage errors make the run `partial`.
- Finder: stage result summary remains compact; detailed funnel metrics stay in `discovery_run_metrics`.
- Researcher, Sender, Follow-up, Reactivation: Decision Engine outcomes are batch-recorded as decision steps.
- Writer: meaningful pipeline stage timing/outcome; AI generation calls link through `ai_request_logs` when active.
- Sender/Follow-up/Reactivation: Resend provider steps include lead, durable email intent ID, phase, retry count, acceptance/uncertainty, provider ID and RFC Message-ID.
- Hostinger inbound: receipt ID, Trigger run/attempt and provider processing outcome are correlated.
- Inbound reply: status transition is recorded through the shared transition helper.

No Orchestrator, planner, LLM routing, agent consolidation, Reply Agent, tenant/workspace model, billing, onboarding, or deployment was introduced.

## Run and step schema

Migration: `supabase-v2/migrations/00000000000002_observability_foundation.sql`. The golden baseline and Prompt 8 migration are unchanged.

Runs store type, explicit status/source, Trigger IDs, correlation/idempotency keys, optional lead/category/parent, attempt, optional decision action/reason, timestamps/generated duration, normalized safe error, bounded metadata, and audit timestamps.

Steps store run and optional lead, stable name/type, sequence/attempt, timestamps/generated duration, optional decision fields, provider/model/external IDs/status, bounded input/output summaries, optional usage/cost summary fields, retry/error fields, metadata, and audit timestamps. AI usage normally remains referenced through the new `ai_request_logs.workflow_run_id` and `workflow_step_id`; step usage fields exist for non-AI providers or summaries where no specialized request row exists.

Metadata is limited by database checks (16 KiB per input/output summary, 32 KiB metadata) and application sanitization. Full prompts, email bodies, raw responses, credentials, cookies, and tokens are not stored.

## Status model

The deliberately small shared set is:

| Status | Meaning |
|---|---|
| `queued` | Accepted but not started |
| `running` | Started and not terminal |
| `succeeded` | Intended diagnostic unit completed |
| `failed` | Unit terminated with an error |
| `partial` | Run completed useful work but one or more non-fatal stages failed |
| `skipped` | Deliberately not run; reason is recorded |
| `waiting` | Correctly waiting on time or external state |
| `cancelled` | Explicitly stopped before completion |

Provider `accepted`/`uncertain`/`failed`/`confirmed` values are outcomes, not extra workflow statuses. Email state remains in `emails`.

## Correlation model

Canonical fields are:

| Identifier | Canonical location/use |
|---|---|
| Workflow run UUID | Internal diagnostic primary key; propagated by async server context |
| Trigger task/run | `trigger_task_id`, `trigger_run_id`; Trigger root run is `correlation_id` where available |
| Retry | `attempt` is one-based Trigger/workflow attempt; provider retries use `retry_count` |
| Lead/category | Typed run/step foreign keys where one entity is affected |
| Parent execution | `parent_run_id`; only for independently executed/retried child work |
| Email intent | Existing `emails.id`, stored only in sanitized provider-step summary |
| Inbound receipt | Existing `inbound_receipts.id`, used as correlation and idempotency key |
| Provider IDs | Typed external request/message fields; durable copies remain in provider operational tables |
| AI request | `ai_request_logs.workflow_run_id/workflow_step_id/provider_request_id` |

The service does not mint a redundant trace ID when Trigger run, inbound receipt, or email intent IDs already supply stable correlation.

## Decision Engine integration

Decision logging is downstream of deterministic evaluation and cannot change the result. A decision step stores only `action`, `reasonCode`, `leadId`, the names in `inputsUsed`, optional scalar result metadata, and (when applicable) shadow comparison classification. Full `LeadDecisionContext`, customer content, prompts, and email bodies are excluded. Batch agents insert decisions in one bounded batch per stage instead of N individual inserts.

## Lead status transitions

`activity_log` remains the smallest correct home for status transitions. The shared `observeLeadStatusTransition` helper emits exactly one activity with `lead_id`, `from_status`, `to_status`, actor, reason code, timestamp (`created_at`), and active workflow run/step IDs. It normally uses `lead_status_transition`; existing `lead_marked_dead` event names are preserved where reports depend on them, with the same canonical transition metadata added. It is used on the high-value Researcher, Sender, Follow-up, Reactivation, and inbound-reply transitions touched in this phase. Generic workflow steps do not duplicate the same transition.

`leads.status` remains authoritative. A transition activity cannot change or reconstruct current lead state.

## AI usage and cost

`src/ai/observability/pricing.ts` remains the only cost-calculation source. The existing AI logger continues to store provider/model, input/output/total tokens, duration, retries, status, estimated cost, and safe metadata. Prompt 10 adds nullable run/step/provider-request links. No cost formula was copied into the workflow service. When pricing or usage is unavailable, cost/tokens remain null.

## Provider identifiers and errors

Provider steps can store provider, model, external request ID, external message ID, response status, latency through timestamps, retry count, and safe summaries. Resend is implemented first; Hostinger correlates receipt and Trigger IDs. Google Places, Outscraper, Anthropic, OpenAI, and Gemini retain their existing aggregate/AI logging and can adopt request IDs as their SDKs expose them.

Normalized categories are `VALIDATION`, `DATABASE`, `PROVIDER`, `NETWORK`, `RATE_LIMIT`, `AUTH`, `SUPPRESSION`, `CONFIGURATION`, `CONCURRENCY`, `TIMEOUT`, and `UNKNOWN`. Stored errors contain a safe code, redacted/truncated message, retryable flag and attempt/provider context. Raw stack traces are excluded from the new tables; existing server logs retain their prior policy.

## Sanitization

`src/lib/observability/sanitize.ts` is the single sanitizer. It recursively caps depth, keys, array length and strings; bounds final JSON size; and redacts key variants for API keys, authorization, passwords, secrets, tokens, service-role material, cookies, OAuth, payload/content, prompts, and message/email bodies. Error messages redact credential-shaped strings and email addresses. Database size constraints are a second line of defense.

## Security and diagnostics

RLS is enabled on both tables. `anon` has no table or RPC access. `authenticated` receives SELECT only, with rows visible solely through `is_active_admin()` policies; members see no rows and cannot mutate. `service_role` receives SELECT/INSERT/UPDATE for operational recording. Browser admins cannot insert, update, or delete.

Bounded `SECURITY INVOKER` RPCs provide latest/filtered runs (maximum 200), one run with ordered steps, Decision Engine action/reason distribution, AI usage/cost summary, and provider failure summary. They inherit table RLS and therefore expose diagnostics only to active admins. No admin UI was added: a safe backend foundation was higher value, and the existing UI would require non-trivial filtering/detail work.

Indexes directly support latest runs, failures/partials, lead history, type/status/date filtering, decision distribution, Trigger/correlation/idempotency lookup, ordered steps, failed/provider steps, and AI run linkage. No JSON GIN or speculative high-cardinality cost indexes were added.

## Performance and failure semantics

Writes are bounded and best-effort. Stage runs use one insert/start and one terminal update. Decision observations use one batch insert per agent stage. Provider calls require one start and terminal update per external call because acceptance and uncertainty are materially diagnostic. No inline aggregation, N+1 decision inserts, giant JSON, or duplicate AI price calculation is performed.

If observability storage fails, the service emits a sanitized structured fallback log and normally returns without breaking business execution. Each write has a 1.5-second application-side wait cap so a stalled telemetry store cannot indefinitely hold the business path. Strict mode exists for a future explicitly audit-critical caller, but current workflow telemetry uses best-effort mode. Durable business facts do not depend on it:

- outbound acceptance/intents remain durable in `emails`;
- inbound claims/outcomes remain in `inbound_receipts`;
- suppression and unsubscribe state remain in their operational records;
- dead-letter recovery remains in `dead_letter_queue`;
- admin/security changes remain durable audit events under their existing policy.

## Retention and volume

Recommended policy (documented, not automated in this phase): retain detailed workflow steps for 60 days, run headers and failure summaries for 180 days, AI/provider aggregate usage for at least 13 months, and legally/security audit-critical records according to the separate audit policy. Before deletion automation, introduce daily aggregate tables or an analytics archive, export cold partitions/object storage, and validate legal requirements. Schedule chunked deletion by indexed `created_at`; never couple retention to workflow execution.

Expected volume is dominated by per-lead decision steps and provider calls. Decision inserts are batched, payloads are bounded, and diagnostic queries are capped. If volume materially increases, monthly time partitioning and archived aggregates are the next evidence-driven changes.

## Verification results

The following passed on the isolated local V2 database/application on 15 September 2026:

- `test:observability:v2`: run start/complete/fail, step complete/fail/skip, parent/correlation, lead and Decision Engine fields, Trigger ID/attempt, provider IDs/retry, AI request link/tokens/cost, redaction/bounds/error normalization, best-effort failure, valid duration, and admin/member/anon/service access.
- `test:decision-engine:v2`: 33 decision cases, five transitions, four shadow comparisons, five integrated paths, bounded context batch 100.
- `test:performance-reliability:v2` and `test:application:v2`.
- Follow-up and Reactivation eligibility, template-mode AI boundaries, Resend send idempotency, webhook handling (47 checks), and Hostinger inbound tests.
- V2 catalog/behavior and negative-security SQL suites after updating the expected table count from 25 to 27.
- `typecheck:v2` and `build:v2` (Next.js 16.2.4 production build, 45 routes).

The final isolated local observability integration path (multiple run/step/status/AI writes and reads, not a single-write benchmark) completed in 1,019 ms. This is environment-specific evidence, not an SLA or a per-workflow latency promise. Critical-path writes remain bounded, and analytics aggregation is absent from send execution.

No real sends, Trigger runs, Finder runs, Hostinger mutations, deployments, or production database changes were performed.

## Known limitations

- Existing legacy activity rows may still contain ad hoc error metadata/stack traces; the new service does not retroactively rewrite them.
- Per-request identifiers are only populated where provider SDKs expose them.
- Decision shadow classification has a schema location but is only captured when a shadow caller supplies it; shadow mode remains non-executing.
- There is no retention job, archive pipeline, dashboard UI, or cross-service distributed tracing backend yet.
- Standalone direct agent invocations outside an observed Trigger/request context retain legacy logs but do not mint duplicate workflow runs. Future independently scheduled tasks should explicitly create a run.
