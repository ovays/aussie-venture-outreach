# ReachAgent V2 agent consolidation

Implementation date: 15 September 2026 (Australia/Sydney)
Status: implemented in the isolated V2 branch; production untouched

The pre-change inventory is recorded in `docs/reachagent-v2-agent-consolidation-baseline.md`. The final execution direction is:

`Trigger.dev -> Orchestrator -> Decision Engine -> exact-lead executor/service -> AI capability only when requested`

## Final classification and boundaries

Only two current capabilities are genuinely AI-driven:

1. Research, for `CONTACT_DISCOVERY` or `PERSONALIZATION`.
2. Writer, for personalized initial content.

Reply is explicitly deferred. Finder, initial delivery, Follow-up, Reactivation, template rendering, quota, suppression, duplicate detection, ownership, lifecycle transitions, provider transport and inbound matching are deterministic.

Legacy files under `agents/` remain compatibility wrappers/entry points. `agents/enricher.ts` has no active import or Trigger/runtime dependency and remains deprecated rather than deleted. Its unbounded selection and duplicated enrichment are not integrated into V2.

## Research contract

`researchLead({ client, leadId, purpose })` in `src/services/research/` loads exactly one lead and returns a bounded normalized result:

```ts
{
  outcome: 'completed' | 'failed'
  changedState: boolean
  emailFound?: boolean
  researchCompleted?: boolean
  personalisationCompleted?: boolean
  summary?: { emailMethod?: string; emailRounds?: number; error?: string }
}
```

It does not decide eligibility, mode, sending or next action. `researchPurposeForMode` maps template to `CONTACT_DISCOVERY` and personalized mode to `PERSONALIZATION`. Contact-only execution does not call website-personalization extraction and no longer writes/clears personalization fields. The bounded Researcher wrapper and Orchestrator both use this service.

## Initial Content and Writer contracts

`generateInitialContent({ client, leadId, mode, operation? })` is the exact-lead entry point. It owns implementation selection:

- template mode -> `renderInitialTemplate` -> existing deterministic category template validation/substitution;
- personalized mode -> `writePersonalizedInitialContent` -> configured AI workflow/provider registry.

The Writer boundary in `src/ai/writer/` contains no Decision Engine or workflow-routing rule. The template boundary in `src/services/initial-content/template-renderer.ts` contains no AI import. Existing pending content is recovered without another Writer call. `writeOneLead`, used by the bounded legacy Writer wrapper, delegates generation to the same Initial Content service.

The resulting template flow remains Finder -> Decision Engine -> deterministic template generation -> send, with zero Writer calls. If a template lacks contact data, only `CONTACT_DISCOVERY` runs; expensive personalization remains skipped.

## Sender boundary

`sendInitialOutreach({ client, leadId, decisionReason })` is the deterministic exact-lead delivery boundary used by the Orchestrator adapter. Budget locking and quota checks remain executor-local; durable delivery behavior remains in the service and existing reliability primitives:

- pending intent exists before transport;
- email UUID drives the stable Resend idempotency key and RFC Message-ID;
- recipient ownership, suppression, source/status and send-time state are rechecked;
- accepted, uncertain, explicit failure and local sync failure remain distinct;
- provider message ID and repair state remain durable.

The legacy Sender entry point remains intact for default-disabled Orchestrator compatibility. Its proven implementation is not deleted or broadly rewritten in this phase.

## Follow-up and Reactivation

`sendFollowUp({ client, leadId, type })` requires an exact `follow_up_1`, `follow_up_2` or `follow_up_3`; it cannot choose a stage or batch. It delegates to the same proven durable exact-send implementation used by the legacy bounded wrapper. Decision Engine chooses the stage and Trigger chooses when to check.

`sendReactivation({ client, leadId })` performs one exact requested reactivation with deterministic stored content, ownership/suppression/status rechecks, durable intent and stable provider identity. Candidate selection and `REACTIVATE`/`WAIT`/`MARK_DEAD` policy remain outside it. The legacy wrapper remains during compatibility rollout.

## Finder, Tracker and deferred Reply

Finder remains `Trigger -> runFinderAgent -> created leads -> Orchestrator`. It is not a `DecisionAction` executor. Prompt 8 batch duplicate lookup, in-run dedupe index and atomic insert protection are unchanged.

Tracker/inbound remains deterministic: provider receipt dedupe/claim, headers/thread matching, automated-mail filtering, sender fallback, state progression and delivery suppression. No Reply Agent, AI inbound classification, or reply send path was added.

Future boundary only:

`Inbound provider -> deterministic receipt/matching -> normalized inbound message -> future Reply classification -> Decision Engine HANDLE_REPLY policy -> approved reply/manual action`

Future classifications remain `INTERESTED`, `NOT_INTERESTED`, `PRICING`, `INFO_REQUEST`, `REFERRAL`, `OUT_OF_OFFICE`, `UNSUBSCRIBE`, and `UNCLEAR`.

## Orchestrator and observability

`src/domain/orchestrator/executors.ts` now imports the canonical Research, Initial Content, outbound, Follow-up and Reactivation service boundaries. It imports no batch agent and no AI provider. Every action remains exact-lead scoped. Finder is not mapped.

The existing async workflow context is preserved, so service/provider/AI writes correlate to the current workflow run/step rather than creating nested runs. Decision action/reason, lead, AI provider/model/tokens/latency/cost, provider request and durable email intent continue to use Prompt 10 telemetry.

## Duplicate reduction and compatibility

- Researcher and Orchestrator now share `researchLead` and one purpose vocabulary.
- Legacy Writer and Orchestrator now share `generateInitialContent`.
- Orchestrator no longer contains the deep initial-send, Follow-up loading/send, or Reactivation implementations.
- Template implementation selection exists only in Initial Content routing; the template renderer is deterministic.
- Follow-up’s proven low-level delivery function remains the single transport implementation shared by its wrapper and service boundary.
- Legacy Sender and Reactivation wrappers remain as compatibility implementations pending shadow-readiness parity; deleting them now would violate the legacy-default requirement.

No old entry point was removed. `ORCHESTRATOR_ENABLED=false` and `ORCHESTRATOR_SHADOW=false` remain the defaults.

## Performance, errors and security

Exact services use `eq(id/lead_id)` and bounded single-row/history queries; they contain no candidate scan or unbounded parallelism. Batch wrappers retain their existing caps. Service results use `completed`, `skipped`, `waiting` and `failed`, with provider/DB errors either returned with retryability or thrown to the Orchestrator error boundary.

No browser operation, RLS/service-role boundary, secret handling, sanitizer or production guard changed. No migration was added; migrations `00000000000000`, `00000000000001` and `00000000000002` are untouched.

## Verification record

Passed locally on 15 September 2026:

- `test:agent-consolidation:v2`, including service-only Orchestrator imports, no AI router, template/Writer separation, purpose mapping, exact-lead scope, FU1/FU2/FU3 mappings, durable identities, Finder exclusion, deterministic Tracker, deferred Reply, bounded wrappers and false defaults;
- `test:orchestrator:v2` and `test:decision-engine:v2` (33 cases);
- `test:observability:v2` (1,246.7 ms local integration path, not an SLA), `test:performance-reliability:v2`, and `test:application:v2`;
- template AI boundaries, Initial Email router, CSV routing, generation-source paths, outreach signature and Writer dedupe-index refresh;
- follow-up and reactivation eligibility, Resend send idempotency, duplicate Follow-up prevention, duplicate send protection, bulk-send duplicate protection and atomic quota enforcement;
- webhook handling (47 checks), Hostinger webhook/inbound queue behavior, Finder test, and batch-agent error isolation;
- `typecheck:v2` and `build:v2` (Next.js 16.2.4, 45 routes).

The legacy Follow-up eligibility script used its own `.env.local` profile and was read-only; it reported no sends or mutations. The Finder test also used its documented diagnostic path (one Google Maps query plus read-only known-domain loading), not `runFinderAgent`; it created no leads and sent no email. No V1 mutation-oriented suite was run. SQL catalog/security suites were not rerun because Prompt 12 added no migration or schema change; migrations remain exactly `00000000000000` through `00000000000002`.

## Remaining cleanup before shadow rollout

- Redirect the remaining authenticated bulk/manual content callers to `generateInitialContent` after their response-shape parity tests are expanded.
- Convert the legacy Sender and Reactivation batch loops into thin selectors over the canonical exact services once compatibility telemetry can compare per-item outcome semantics.
- Move the low-level Follow-up send implementation physically out of `agents/followup.ts` after legacy import compatibility is proven; the public service contract is already canonical.
- Split Tracker digest concerns from inbound processing when those tasks next change.
- Remove deprecated Enricher only after production dependency evidence is available in the controlled rollout phase.
