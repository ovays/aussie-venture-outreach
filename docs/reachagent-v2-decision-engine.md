# ReachAgent V2 Decision Engine Foundation

Date: 2026-09-15

Status: READY

Scope: isolated ReachAgent V2 branch and local V2 Supabase only. Production application, database, data, providers, schedules, and deployment were not changed.

## Architecture

The Decision Engine is deterministic domain code. It answers one question: **what action is valid next for this lead?**

```text
Supabase facts -> bounded context loader -> pure Decision Engine -> action + reason
                                                               |
                                                               v
                                      existing deterministic executor/service
```

- Supabase remains the durable state authority.
- The engine owns per-lead eligibility and next-action rules.
- Trigger.dev still owns when jobs run, stage sequencing, retries, concurrency, and quotas.
- Existing services still research, render templates, call AI, send mail, claim recipients, persist transitions, and recover uncertain sends.
- The engine performs no queries, mutations, provider calls, scheduling, logging, or other side effects.
- No LLM selects workflow actions.

The pre-change inventory is in `docs/reachagent-v2-decision-engine-baseline.md`.

## Canonical action model

The smallest action set supported by current executable workflows is:

| Action | Meaning | Executor boundary |
|---|---|---|
| `STOP` | Automated outreach must not progress | No-op; suppression/terminal state remains durable elsewhere |
| `RESEARCH` | Required contact or personalised facts are missing | Researcher service |
| `GENERATE_INITIAL` | Initial content is missing and may be materialized | Writer or category-template service |
| `SEND_INITIAL` | A durable initial draft exists and is eligible to send | Sender service |
| `WAIT` | Valid lifecycle, but no action is due | No-op |
| `SEND_FOLLOWUP_1` | FU1 is the first missing stage and is due | Follow-up service |
| `SEND_FOLLOWUP_2` | FU2 is the first missing stage and is due | Follow-up service |
| `SEND_FOLLOWUP_3` | FU3 is the first missing stage and is due | Follow-up service |
| `REACTIVATE` | Full sequence is complete and configured reactivation is due | Reactivation service |
| `HANDLE_REPLY` | A normalized human reply needs reply-domain handling | Existing deterministic receipt path now; future Reply Agent boundary later |
| `MARK_DEAD` | No-response terminal deadline is reached | Follow-up/Reactivation deterministic service |
| `MANUAL_REVIEW` | State is inconsistent, uncertain, or needs an explicit operator decision | Admin/manual workflow |

`READY_TO_SEND` is represented durably by lead status `email_ready` plus a pending email; the actionable engine result is `SEND_INITIAL`. Follow-up generation is currently part of the Follow-up executor, so separate `GENERATE_FOLLOWUP_*` business actions would encode an implementation detail and were not added. `dm_queued` is queue state, not an action or lead status.

## Stable reason codes

Reason codes are exported from `src/domain/decision-engine/types.ts` and are the only machine-readable explanation contract:

- safety/terminal: `DUPLICATE_LEAD`, `SUPPRESSED`, `UNSUBSCRIBED`, `TERMINAL_STATUS`, `ACTIVE_DEAL_STATUS`, `MISSING_EMAIL`;
- reply: `REPLY_RECEIVED`, `REPLY_CLASSIFICATION_REQUIRED`, `OUT_OF_OFFICE`;
- template/personalised: `TEMPLATE_READY`, `TEMPLATE_RESEARCH_REQUIRED`, `TEMPLATE_CONFIGURATION_INVALID`, `TEMPLATE_DATA_UNAVAILABLE`, `PERSONALIZED_RESEARCH_REQUIRED`, `INITIAL_CONTENT_REQUIRED`, `INITIAL_CONTENT_READY`;
- consistency: `INITIAL_SEND_UNCERTAIN`, `FOLLOWUP_SEND_UNCERTAIN`, `STATUS_CONTENT_MISMATCH`, `INITIAL_SEND_MISSING`, `MANUAL_OVERRIDE_REQUIRED`;
- follow-up: `FOLLOWUP_1_READY`, `FOLLOWUP_2_READY`, `FOLLOWUP_3_READY`, `FOLLOWUP_NOT_DUE`, `FOLLOWUP_SEQUENCE_COMPLETE`;
- reactivation: `REACTIVATION_DISABLED`, `REACTIVATION_NOT_DUE`, `REACTIVATION_READY`, `REACTIVATION_ALREADY_SENT`, `REACTIVATION_DEADLINE_REACHED`.

Each result includes `action`, `reasonCode`, `leadId`, the explicit `inputsUsed` keys, and optional scalar execution metadata. There is no free-form or hidden AI reasoning.

## Context contract

`LeadDecisionContext` contains normalized facts rather than database rows:

- lead ID, canonical status, email presence, duplicate and suppression facts;
- deal state;
- initial-email mode (`template` or `ai_personalised`);
- contact-discovery and personalisation completeness;
- template availability, required-value readiness, and whether research can supply missing values;
- summarized initial/FU1/FU2/FU3 email states (`missing`, `pending`, `sent`, `uncertain`) and timestamps;
- reply receipt and optional normalized classification;
- reactivation enablement/sent time;
- FU, dead, and reactivation intervals;
- caller-supplied deterministic `asOf` timestamp;
- optional explicit manual override request.

Full email bodies and full histories are not part of the decision contract.

## Pure decision priority

Rules are evaluated in this safety order:

1. duplicate and suppression stop all automated progression;
2. closed/closed-manual/closed-deal state stops progression;
3. a normalized reply is handled before ordinary outreach, preserving late `dead -> replied` recovery;
4. dead stops ordinary outreach; interested/negotiating/active-deal states stop automated follow-up;
5. manual override intent requires explicit review;
6. pre-contact states route through template/personalised rules;
7. contacted state routes through sequential FU, reactivation, and terminal timing rules.

An executor must still repeat irreversible-action checks. A stale decision can never bypass recipient ownership, delivery suppression, distributed locks, durable send intent, or provider idempotency.

## Template-mode rules

- Duplicate, suppressed, unsubscribed, closed, closed-manual, and dead leads stop.
- A missing email on a new lead routes to contact discovery.
- A template-ready new lead with an email and every referenced lead value routes directly to `GENERATE_INITIAL`; Researcher AI is skipped.
- A missing template or invalid template routes to `MANUAL_REVIEW`.
- Missing required template data routes to `RESEARCH` only when the normalized context says current research can supply it; otherwise it routes to `MANUAL_REVIEW`.
- Existing pending initial content routes to `SEND_INITIAL`, never duplicate generation.
- The renderer remains authoritative for placeholder validation and content materialization.

The active Researcher integration advances template-ready `new` leads to `researched` without calling research providers; the existing Writer/template executor then materializes content in the same pipeline. This is the documented `EXPECTED_V2_CONSOLIDATION` from the baseline.

## Personalized-mode rules

- A new or otherwise incomplete lead routes to `RESEARCH`.
- Research-complete with no initial content routes to `GENERATE_INITIAL`.
- A research-complete lead with no email stops with `MISSING_EMAIL`.
- Pending initial content routes to `SEND_INITIAL`.
- Delivered initial content paired with a pre-contact status is treated as `STATUS_CONTENT_MISMATCH`, not regenerated.
- An uncertain irreversible send routes to `MANUAL_REVIEW`, never a blind retry.

AI prompt and content behavior were not changed.

## Follow-up rules

- Only `contacted` leads with a delivered initial email are evaluated.
- FU1, FU2, and FU3 remain strictly sequential.
- Eligibility remains measured from the initial send at configured 7/14/21-day defaults, matching current executable semantics.
- A stage is actionable only when it is the first missing stage and its threshold is reached.
- A pending stage is eligible for its same send action; the durable intent/provider idempotency boundary safely resumes it.
- An uncertain stage requires manual review.
- Any reply, suppression, active opportunity, or terminal status prevents automated follow-up.
- With reactivation disabled, the existing executor retains its next-day post-FU3 dead-mark boundary. The engine exposes `MARK_DEAD` after the summarized boundary is reached.

The Follow-up agent now uses the central result to admit FU candidates. Its legacy computation remains temporarily for diagnostics, existing lifecycle counters, and shadow parity; it no longer independently authorizes a send.

## Reactivation rules

- Reactivation requires `contacted`, no reply/suppression/active deal, a delivered initial, and a complete sequential FU1/FU2/FU3 history.
- Timing preserves actual executable V2 behavior: `reactivation_delay_days` is measured from the initial send and defaults to **60 days**.
- This intentionally follows code and the lifecycle RPC. The old setting description saying “after dead” is inaccurate and remains a documentation cleanup item; no timing was invented.
- Before due: `WAIT / REACTIVATION_NOT_DUE`.
- Due: `REACTIVATE / REACTIVATION_READY`.
- After a reactivation send: `WAIT / REACTIVATION_ALREADY_SENT` until the configured default 14-day terminal interval.
- At that terminal interval: `MARK_DEAD / REACTIVATION_DEADLINE_REACHED`.

Daily quotas, template generation, recipient claims, send-time status checks, durable intents, and provider calls remain in the Reactivation executor.

## Reply boundary

Reply classification is not implemented in Prompt 9. The engine only accepts a normalized future input:

| Classification | Next-action meaning |
|---|---|
| `INTERESTED`, `PRICING`, `INFO_REQUEST`, `REFERRAL`, `UNCLEAR` | `HANDLE_REPLY`; a future Reply Agent or operator decides content/status details |
| `NOT_INTERESTED` | `HANDLE_REPLY`; the executor/future reply policy performs the approved closure or suppression action |
| `OUT_OF_OFFICE` | `WAIT`; matches current deterministic automated-message ignore behavior |
| `UNSUBSCRIBE` | `STOP`; deterministic unsubscribe/suppression remains a service responsibility |

Tracker still performs deterministic provider-message matching, obvious automated-mail filtering, receipt persistence, and current `contacted/dead -> replied` transition behavior. It does not use an LLM.

## Canonical transition model

`src/domain/decision-engine/transitions.ts` is the authoritative allowed-edge map. Important rules:

- automated progression: `new -> researched -> email_ready -> contacted`;
- inbound recovery: `contacted -> replied` and late `dead -> replied`;
- no-response terminal: `contacted -> dead`;
- deal creation: eligible active states -> `closed`;
- `closed_manual` is manual-only;
- interested/negotiating advancement and regression are manual-only in this foundation;
- `closed` and `closed_manual` have no outgoing transitions;
- `dead` is terminal for automated outbound work, with only the late-reply recovery edge;
- same-state writes are idempotent no-ops;
- `closed_won` and `dm_queued` are not canonical lead statuses.

The existing broad PATCH endpoints are not yet blocked by this map. Prompt 9 deliberately uses transition checks as the authority and shadow/test contract first, because enforcing previously unrestricted manual transitions would be a customer-facing behavior change. Enforcement is a remaining integration item, not permission for modules to add statuses.

## Bounded context loading

`loadDecisionContext` and `loadDecisionContexts` support one lead or a bounded batch.

- hard maximum: 100 unique lead IDs;
- database calls: 5 when no category lookup is needed, otherwise 6;
- lead projection: only decision fields;
- email projection: six scalar columns, five lifecycle email types, and only `pending_send`, `sent`, or `email_sync_failed` rows;
- email bound: at most `6 * batch size` rows;
- mode-snapshot bound: at most `10 * batch size` rows;
- deal bound: at most `10 * batch size` rows;
- template projection: initial templates only, bounded by distinct category count;
- calls are set-based with no per-lead query loop;
- loader returns call/row metrics and missing IDs.

The loader uses generated V2 database row types. No `select('*')`, unbounded history, N+1 query, provider call, or new datastore was introduced.

## Integration points

Prompt 9 intentionally integrates only high-value shared gates:

- Researcher: engine decides whether a `new` lead actually needs research; template-ready leads bypass unnecessary research work.
- Sender: engine must return `SEND_INITIAL` before an initial candidate enters the irreversible send boundary.
- Follow-up: engine authorizes FU1/FU2/FU3 candidate admission.
- Reactivation: engine authorizes reactivation and post-reactivation dead marking.
- Lifecycle API: optional `DECISION_ENGINE_SHADOW=true` compares the bounded page projection against engine results and logs differences only; it never executes actions or changes the response.

Feature flag default is off. Shadow mode cannot send, schedule, mutate, or duplicate work.

## Shadow comparison

`compareDecisionWithLegacy` compares representative current executable rules with the engine. `compareDecisionWithLifecycleProjection` compares the paged lifecycle action/overdue projection. Differences are classified as:

- `EXPECTED_V2_CONSOLIDATION`;
- `BUG_IN_OLD_LOGIC`;
- `BUG_IN_NEW_ENGINE`;
- `PRODUCT_DECISION_REQUIRED`;
- or `MATCH` when no difference exists.

Known approved consolidation: a template-ready new lead changes from the legacy blanket `RESEARCH` decision to `GENERATE_INITIAL`. Any unclassified runtime difference is `PRODUCT_DECISION_REQUIRED` and cannot drive shadow-mode side effects.

## Database changes

None. Prompt 9 adds no migration, table, column, index, function, status, workflow-run model, or observability schema. The immutable golden baseline and Prompt 8 incremental migration are unchanged.

## Tests and verification

`scripts/test-v2-decision-engine.ts` covers 33 deterministic decision cases, including every required Prompt 9 scenario:

- template sufficient/missing/researchable/invalid paths;
- personalized new/researched paths;
- `email_ready`, duplicate content, missing and uncertain sends;
- FU1/FU2/FU3 due and not-due sequencing;
- replies, unsubscribe, out-of-office, interested, negotiating, closed, closed-manual, dead, suppression, and late reply;
- reactivation not due, due, already sent, and terminal deadline;
- duplicate candidate and manual override;
- allowed, forbidden, automated, manual-only, terminal, and late-reply transitions;
- legacy and lifecycle shadow comparisons;
- the 100-ID hard loader bound and a synthetic local Supabase load/action check;
- static checks that the four active executor paths import the central engine.

Verification results:

- `npm run test:decision-engine:v2`: PASS (33 cases, 5 transition assertions, 4 shadow checks, bounded local loader).
- `npm run test:performance-reliability:v2`: PASS.
- `npm run test:application:v2`: PASS.
- existing follow-up eligibility: PASS.
- existing reactivation eligibility: PASS.
- existing template-mode AI-boundary suite: PASS.
- `npm run typecheck:v2`: PASS.
- `npm run build:v2`: PASS (Next.js 16.2.4).

No test sends real email, mutates Hostinger, starts a production Trigger job, runs a production Finder schedule, or deploys V2.

## Remaining duplicated logic and risks

- Lifecycle SQL and dashboard counters retain their set-based display projections; they are shadow-compared rather than rewritten in this foundation.
- `computeFollowUpEligibility` and `determineNextEmailType` remain compatibility helpers for existing diagnostics/manual thread construction. Active automated authorization now uses the engine.
- Manual/bulk resend and regeneration routes retain executor-local rechecks. Further adoption can replace their coarse eligibility gates without changing provider/idempotency safeguards.
- General lead PATCH endpoints still permit historically supported manual status writes. Enforcing the transition map needs a separately reviewed product-compatibility change.
- Legacy `agents/enricher.ts` is not part of the active daily pipeline and still contains independent `new/researched/dead` decisions.
- The future Reply Agent must supply normalized classifications; it must not redefine engine routing or deterministic unsubscribe behavior.
- Template `contact_name` is not a stored lead field. A template requiring it correctly routes to manual review unless a future approved context source can supply it.
- Shadow comparisons are diagnostic only and do not create an observability framework.

## Deferred by scope

Not implemented: workflow runs/steps, full observability, an orchestrator service, agent consolidation, Reply Agent classification, workspace/tenant modeling, production migration, production deployment, or new customer UI.
