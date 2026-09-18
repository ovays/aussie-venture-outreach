# ReachAgent V2 agent consolidation baseline

Audit date: 15 September 2026 (Australia/Sydney)
Branch: `reachagent-v2-application`
Scope: local/synthetic V2 only

This inventory was completed before deleting or replacing any entry point. No agent was deleted. The audit covered `agents/`, `src/ai/`, the relevant `src/lib/` domain utilities, `src/domain/orchestrator/`, API/bulk callers, and Trigger tasks.

## Agent inventory before consolidation

| File/module | Real responsibility and class | Inputs / outputs | DB mutations | External calls | Decision/Orchestrator overlap and duplication | V2 destination | Disposition |
|---|---|---|---|---|---|---|---|
| `agents/finder.ts` | Deterministic discovery/ingestion (B, C, E) | Active category/location/settings; returns lead count/runtime limit | Leads, discovery state/metrics, activity | Outscraper, Google/website HTTP | Correctly precedes lead orchestration; contains provider crawling and atomic duplicate-safe ingestion, not AI routing | Future `FinderService`; remains Trigger-owned | Keep; rename boundary later, no risky move |
| `agents/researcher.ts` | Bounded candidate wrapper plus research execution (D, F; underlying capability A) | Mode snapshot and bounded `new` leads; count processed | Lead research fields/status, activity; bounced-address repair | Website HTTP and configured AI workflows | Selected candidates and interpreted Decision Engine action, then called low-level research; duplicated exact-lead loading in Orchestrator | `researchLead({leadId,purpose})`; batch wrapper retained | Adapt |
| `agents/writer.ts` | Bounded candidate/recovery wrapper (D, F), not itself one AI capability | Mode snapshot and bounded `researched` leads; summary/activity | Pending initial email, lead status, activity; stale-status recovery | Writer AI only through routing utility | Batch selection, dedupe and mode branching surrounded shared generation; Orchestrator called router directly | `generateInitialContent({leadId,mode})`, with Writer AI only for personalized mode | Adapt; retain wrapper |
| `agents/sender.ts` | Initial delivery executor/batch wrapper (C, E, F), not AI | Settings/quota and bounded pending intents; sent/failed counts | Email intent/outcome, lead status, claims, activity/DLQ | Resend | Legacy implementation and Prompt 11 adapter duplicated exact delivery behavior; Decision checks in batch are routing gates, while send-time status/suppression/ownership checks are required safety | `sendInitialOutreach({leadId})` behind budget executor | Adapt incrementally; preserve legacy reliability path |
| `agents/followup.ts` | Candidate scheduler wrapper plus exact-stage delivery (C, D, E, F) | Contacted candidates, schedule/quota; per-stage sends | Email intent/outcome, follow-up row, lead/dead transition, activity | Resend | Batch selects FU stage and dead transitions using Decision Engine; Orchestrator had separate candidate loading around the same exact send function | `sendFollowUp({leadId,type})`; legacy batch wrapper retained | Adapt; exact send remains shared |
| `agents/reactivation.ts` | Candidate scheduler wrapper plus delivery/lifecycle (C, D, E, F) | Contacted candidates, reactivation settings/quota | Email intent/outcome, timestamp, dead status, activity | Resend | Batch chooses eligible/dead actions; Prompt 11 adapter duplicated exact reactivation send | `sendReactivation({leadId})`; legacy wrapper retained | Adapt incrementally |
| `agents/tracker.ts` | Deterministic inbound receipt/matching, failure handling, analytics digest (B, E, D) | Provider events/normalized inbound/digest schedule | Email/lead/follow-up status, suppression, activity | Resend headers/send for digest | No AI classification. Reply receipt matching must remain before any future Reply capability | Inbound/Tracker services; Reply boundary deferred | Keep; rename/split later |
| `agents/enricher.ts` | Superseded unbounded enrichment pipeline (G; contains A/E internally) | All `new` leads and quota | Lead fields/status, deletes overflow, activity | Website HTTP and AI workflows | Duplicates Researcher contact/personalization and is absent from Trigger/API/V2 imports | Deprecated legacy only | Deprecate; remove later after production compatibility proof |

## Supporting service and capability inventory

| Module(s) | Responsibility | Class | Notes / destination |
|---|---|---|---|
| `src/ai/AIProvider.ts`, `AIRegistry.ts`, `AIRuntime.ts`, `providers/*`, `configuration/*`, `observability/*` | Provider-neutral AI configuration, execution, usage/cost telemetry | A, E | Keep as the only provider abstraction. Research/Writer must not bind to one vendor. |
| `src/ai/email-generation.ts`, `website-extraction.ts`, `email-extraction.ts`, `workflows.ts` | Personalized writing, website extraction and AI email discovery | A | Retain prompts/quality unchanged; expose clear Research and Writer capability boundaries. Follow-up/reactivation generation is currently deterministic despite historical AI-shaped signatures. |
| `src/lib/research-lead.ts` | One-lead website/contact/personalization implementation and persistence | A, B | Canonical low-level implementation used behind normalized Research service. It must not decide eligibility or next action. |
| `src/lib/initial-email-router.ts`, `initial-email-template.ts`, `category-email-templates.ts` | Initial content implementation selection, deterministic template lookup/validation/rendering | B | Consolidate external callers behind Initial Content; expose a template-only module with no AI import. |
| `src/lib/write-lead.ts`, `process-researched-lead.ts`, `deduplication.ts`, `data-quality.ts` | Legacy writer compatibility, duplicate/suppression/ownership enforcement | B, F | Preserve deterministic checks. `write-lead` should delegate content generation to the shared service. |
| `src/lib/outbound-send.ts`, `resend.ts`, `email-status.ts`, `delivery-suppression.ts`, `distributed-lock.ts` | Durable intent identity, provider transport, uncertain/sync repair, suppression and locking | B, E | Reliability primitives remain canonical and unchanged. |
| `src/lib/followup-eligibility.ts`, `followup-generation.ts`, `followup-email-templates.ts`, `email-sequence.ts` | Deterministic eligibility compatibility, content and thread references | B, F | Decision Engine owns V2 eligibility; exact service owns requested-stage materialization/send. |
| `src/lib/stored-sequence-templates.ts` | Stored/deterministic follow-up and reactivation content | B | Remains outside Writer AI. |
| `src/lib/hostinger-*`, `agents/tracker.ts`, webhook routes/tasks | Receipt validation/claim/dedupe, mailbox matching and state transitions | B, D, E | Deterministic inbound boundary. No Reply Agent. |
| `src/domain/decision-engine/*` | Pure next-action authority and bounded context loading | B | Sole V2 routing authority; no side effects or AI. |
| `src/domain/orchestrator/*` | Exact-lead coordination, iteration/locking/telemetry, executor mapping | C | Before consolidation, `executors.ts` contained deep send/reactivation implementations and imported `agents/followup.ts`; redirect to services. |
| `trigger/daily-pipeline.ts`, `followup-job.ts`, `digest-job.ts`, `hostinger-inbound.ts` | Scheduling, retry/concurrency and invocation | D | Finder remains before per-lead Orchestrator. Legacy path remains default while flags are false. |
| API/bulk routes and scripts | Authenticated/manual compatibility entry points | F | May retain wrappers, but should converge on the same service contracts as touched safely. No browser-direct provider/capability exposure. |

## Explicit responsibility classification

| Responsibility | Class | Authority/destination |
|---|---|---|
| Business/person/context research | A | Research capability |
| Personalized initial writing | A | Writer capability |
| Reply classification | A, deferred | Future Reply capability; not implemented |
| Determine next action / due FU / reactivation policy | B | Decision Engine |
| Coordinate action sequence | C | Orchestrator |
| Render/validate category template and placeholders | B | Template Engine |
| Initial, FU1/FU2/FU3 and reactivation delivery | C | Exact-lead executors/services |
| Scheduling and retries | D | Trigger.dev |
| Resend, Hostinger, Outscraper/Google transport | E | Provider integrations |
| Suppression, duplicate detection, quota, lifecycle, ownership, inbound matching, validation | B | Deterministic domain services/executor safety checks |
| Batch row selection/loops | F | Bounded legacy wrappers only |
| Legacy Enricher | G | Deprecated, inactive, retained pending compatibility proof |

## Pre-change conclusions

- Genuine AI responsibilities are Research and personalized Writer. Reply remains future work.
- Finder, Sender, Follow-up, Reactivation and Tracker are mislabeled as agents; their core behavior is deterministic execution/infrastructure.
- Prompt 11’s orchestrator was exact-lead scoped but reached into a legacy Follow-up module and duplicated initial-send/reactivation implementations.
- The legacy daily pipeline must remain operational with `ORCHESTRATOR_ENABLED=false`; therefore consolidation must use adapters/wrappers, not deletion.
- No schema change is needed.
