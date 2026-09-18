# ReachAgent V2 Decision Engine Baseline

Date: 2026-09-15

Scope: isolated V2 branch and local V2 environment only. This inventory describes the current decision sources before the Decision Engine foundation. No production system was queried or changed.

## Executive summary

Workflow progression is deterministic today, but it is not centralized. Stored lead status is the main coarse-grained signal, while email history, suppression, initial-email mode, category-template readiness, dates, and manual route intent supply additional facts. The same logical questions are answered in several places:

- `new -> researched -> email_ready -> contacted` is spread across Finder, Researcher, Writer, the initial-email router, Sender, staged import, and bulk/manual routes.
- The next follow-up stage is computed by `computeFollowUpEligibility`, `determineNextEmailType`, the Follow-up agent, dashboard aggregation, and `get_lifecycle_page`.
- Reactivation and post-reactivation death are computed independently in the Reactivation agent, dashboard aggregation, and `get_lifecycle_page`.
- Reply receipt is matched and persisted by Tracker; semantic classification does not yet exist.
- Any accepted canonical status can currently be written by the general lead PATCH APIs. There is no allowed-transition map.

The Decision Engine should own pure eligibility and next-action decisions. Existing services should retain side effects, provider calls, claims, durable send intents, quotas, locking, and scheduling.

## Current decision inventory

| Decision | Current file / function | Input state | Decision made | Side effects | Overlap | Prompt 9 disposition |
|---|---|---|---|---|---|---|
| Finder candidate acceptance | `agents/finder.ts`; batched lookup around `lookupFinderCandidates`, final `insert_finder_lead_if_new` RPC | Candidate place ID, normalized email/domain, business identity, suppression/duplicate match | Insert a valid new candidate or skip duplicate/suppressed candidate | Inserts `leads(status='new')`; logs metrics/activity | `createLead`, Writer dedupe, recipient-ownership claim | Duplicate/suppression validity is deterministic data-integrity service logic. The engine consumes a normalized duplicate/suppressed fact and returns `STOP`; it does not replace atomic insert/dedupe RPCs. |
| Finder completion / pipeline continuation | `trigger/daily-pipeline.ts` | Finder result and `runtimeLimitHit` | Continue to Researcher/Writer/Sender unless Finder hit runtime limit; always continue Follow-up/Reactivation except fatal rules | Invokes services | Trigger stage control | Remains Trigger execution policy (`when/how`), not a per-lead Decision Engine rule. |
| Researcher batch eligibility | `agents/researcher.ts:runResearcherAgent` | `system_active`, lead `status='new'`, captured initial-email mode | Select bounded `new` leads; template mode selects contact-discovery-only research, personalised mode selects full research | Calls research provider/service | Bulk research route and legacy Enricher | Per-lead need for research belongs in the engine. Batch selection, system pause, limits, and provider execution remain service/Trigger concerns. |
| Research scope | `src/lib/research-lead.ts:researchPurposeForInitialEmailMode`, `researchOneLead` | Initial-email mode, missing email, website, halal/research fields | Template: contact discovery only; personalised: full personalisation. Skip some provider work when facts already exist | Provider/AI calls; updates lead fields and `status='researched'`; logs | Researcher agent and bulk/retry routes | Engine decides `RESEARCH` versus the next action from normalized completeness facts. Research scope and how research is performed remain deterministic service logic. |
| Legacy enrichment eligibility | `agents/enricher.ts:runEnricherAgent` | `status='new'`, quotas, rating order | Enrich until quota; no email/error becomes dead; overflow rows are deleted | Provider calls, updates/deletes leads | Researcher is the active daily pipeline path | Do not integrate this legacy/non-pipeline path in Prompt 9. Document as remaining duplicated logic. It must not invent a new engine status/action. |
| Writer batch eligibility | `agents/writer.ts:runWriterAgent` | `system_active`, `status='researched'`, suppression columns, initial mode snapshot/current setting | Process researched unsuppressed leads; reset stale `email_ready` without pending/sync-failed email to researched | Calls Writer/template service; status repair; logs | Bulk processing and resend-on-demand | `GENERATE_INITIAL`, `STOP`, and `MANUAL_REVIEW` eligibility belongs in the engine. Batch limits, stale-row repair, generation, and persistence remain service logic. |
| Initial mode selection | `src/lib/initial-email-router.ts:readInitialEmailMode`; `src/lib/initial-email-mode-snapshot.ts`; daily pipeline batch snapshot | Current setting or per-import snapshot | Choose `template` or `ai_personalised` for a lead/batch | Reads settings/activity; snapshots imports | Import, Writer, manual generation routes | Mode is a normalized context fact. The engine never reads settings itself. Import snapshots continue to preserve current behavior. |
| Template readiness and rendering | `src/lib/initial-email-template.ts:generateInitialEmailFromTemplate`; settings PATCH template-mode gate | Category ID/name, active-category template, placeholders and lead values | Template can render, required lead value missing, or template invalid/missing | Reads category/template; renders content | Settings validation and initial router | Engine consumes `templateAvailable`, `templateRequiredDataAvailable`, and whether research can supply missing facts. Validation/rendering stays in template service. |
| Initial content generation and `email_ready` | `src/lib/initial-email-router.ts:routeInitialEmail`; `src/lib/write-lead.ts:writeOneLead` | Mode, lead facts, existing pending email, suppression/ownership, generation lock | Reuse existing pending content or generate template/AI content; missing email becomes dead in Writer | Claims recipient; calls AI/template; inserts/updates email; writes `email_ready`/`dead`; logs | Writer, create/import, bulk process/send, regenerate, retry-research, resend route | Pure engine decides `GENERATE_INITIAL`, `SEND_INITIAL`, `STOP`, or `MANUAL_REVIEW`. Router remains executor and idempotent persistence boundary. Prompt 9 will not move provider or DB side effects into the engine. |
| CSV/manual creation progression | `src/lib/create-lead.ts:createLead`, `backfillLeadStageHistory`; leads/import and leads POST APIs | Valid email/category, current stage/date, mode policy | New manual/import lead starts `researched`; template may generate now, personalised import defers; staged import synthesizes sent history and becomes contacted | Inserts lead/email/follow-up rows; may invoke AI/template; claims ownership | Writer/router/manual routes | Creation/backfill is an explicit manual execution workflow. Engine can evaluate its normalized resulting state, but Prompt 9 will not rewrite backfill behavior. |
| Sender eligibility | `agents/sender.ts:runSenderAgent` | System state, quotas, pending initial email, lead `email_ready`, non-manual source, suppression, prior sent/sync-failed history | Send initial email or skip/repair | Durable send intent/provider call; updates email and lead to contacted; activity/DLQ | Bulk send, resend route, mark-initial-sent route | Engine owns the pure `SEND_INITIAL` eligibility. Quotas, source/manual policy, claims, locks, intent state, provider call, and persistence remain Sender/executor safeguards and must still re-check at send time. |
| Manual initial send | `src/app/api/leads/bulk/route.ts`, `src/app/api/leads/[id]/resend/route.ts`, `mark-initial-sent/route.ts` | Requested lead, lead status, email history, suppression, ownership, lock | Generate missing content if allowed; send or mark external send; advance to contacted | Provider call and DB writes | Automated Sender; email-sequence helper | Use the same pure engine result as a gate/shadow comparison where safe. Manual intent does not bypass suppression or terminal status. Physical/manual send remains route executor logic. |
| Next email in manual sequence | `src/lib/email-sequence.ts:determineNextEmailType` | Sent-at facts for initial/FU1/FU2/FU3 | Initial, first missing follow-up, or complete | None | Follow-up eligibility and lifecycle SQL | Fold into the canonical action vocabulary while retaining this compatibility helper during minimal integration. |
| Follow-up eligibility | `src/lib/followup-eligibility.ts:computeFollowUpEligibility`; `agents/followup.ts:runFollowUpAgent` | Contacted status, email, suppression, initial sent time, sent follow-up flags, FU day settings, current time | First missing FU; due when days since initial reaches FU1/FU2/FU3 threshold | Queue building; send service later generates/sends; may mark dead when all FUs sent and reactivation disabled | Dashboard `getFollowupStats`, manual resend, lifecycle RPC | Canonical engine owns per-lead `SEND_FOLLOWUP_1/2/3`, `WAIT`, `STOP`, and post-sequence result. Schedule semantics remain days-since-initial exactly as current code. Quotas/sending stay outside. |
| Follow-up delivery | `agents/followup.ts:sendFollowUp` | Candidate action, current contacted state, suppression, ownership, prior delivered row, lock/intent | Execute exact FU stage or skip duplicate/ineligible send | AI/template generation, provider call, email/follow-up/activity writes | Manual resend | Executor logic. It must retain send-time rechecks even after engine integration. |
| Reactivation eligibility | `agents/reactivation.ts:runReactivationAgent` | Enabled setting, contacted status, email/suppression, initial sent, FU3 sent, no prior reactivation, days since initial, daily quota | Reactivate when configured delay from initial has elapsed; otherwise wait | Generates/sends reactivation; stores `reactivation_sent_at` | Lifecycle RPC and dashboard calculations | Engine owns `REACTIVATE` versus `WAIT/STOP`; keeps current configured default/code behavior of 60 days (not an invented 90 days). Daily quota and execution stay in service. |
| Post-reactivation terminal decision | `agents/reactivation.ts:runReactivationAgent` | Contacted status, `reactivation_sent_at`, no reply/status change, dead-after-reactivation days | Mark dead after configured delay (default 14 days) | Updates lead to dead; logs | Lifecycle RPC/dashboard | Engine owns a deterministic terminal next action (represented as `CLOSE` to dead only through executor metadata or a dedicated `MARK_DEAD` action if required by actual integration). The executor performs transition/logging. |
| Reply matching | `agents/tracker.ts:processInboundReply`, matching helpers | Provider message IDs/references/sender, automation headers, relevant statuses, prior outbound history | Ignore obvious automated mail; uniquely match or record unmatched/ambiguous | Reads provider headers; logs unmatched; calls reply persistence | Future Reply Agent boundary | Matching and obvious auto-mail filtering remain deterministic Tracker service logic. Semantic reply classification is explicitly deferred. |
| Reply state transition | `agents/tracker.ts:handleEmailReply` | Matched lead status and outbound email | `contacted` or late `dead` becomes `replied`; active/closed states are not regressed | Updates lead/email replied_at; logs | Manual status APIs | Engine defines normalized reply-classification next-action eligibility. Tracker retains durable receipt/matching. Current late `dead -> replied` behavior must be represented in transition rules. |
| Delivery suppression | `src/lib/delivery-suppression.ts`; `agents/tracker.ts:handleTerminalDeliveryFailure`; DB RPCs `suppress_lead_delivery_email`, `claim_recipient_outreach` | Current normalized email, terminal provider status, address history, recipient ownership | Block future outreach for failed/suppressed/owned recipient | Updates email suppression; cancels scheduled FU; claims ownership | Finder, Writer, Sender, Follow-up, Reactivation, manual APIs | Engine consumes normalized `suppressed` and returns `STOP`. Atomic suppression/claim and send-time enforcement stay in DB/services. |
| Data-quality suppression | `src/lib/data-quality.ts`, database constraints/RPCs | Invalid/placeholder/technical/shared recipient conditions | Suppress or deny ownership | Persists flags/claims; may reset lead on email repair | Finder/create/Writer/Sender | Classification/claims remain deterministic services. Engine treats the normalized result as authoritative. |
| Lifecycle display classification | V2 `get_lifecycle_page` RPC; `src/app/api/lifecycle/route.ts` | Contacted and recent dead leads, email summaries, reactivation timestamp, settings, as-of time | Stage, next action label/date, overdue/filter/counts | None | Follow-up agent, Reactivation agent, dashboard analytics | The pure engine becomes the application-domain authority. Existing RPC remains the paged UI projection in Prompt 9; synthetic shadow comparisons must classify differences. No broad UI rewrite. |
| Dashboard lifecycle counts | `src/lib/analytics.ts:getFollowupStats` | Contacted histories, settings, as-of time | FU due, reactivation, awaiting-dead counts | None | Lifecycle RPC and agents | Retain for UI metrics in Prompt 9, but compare shared synthetic facts against the engine. Later replacement can use a set-based engine-compatible projection. |
| Manual status writes | `src/app/api/leads/route.ts:PATCH`; `src/app/api/leads/[id]/route.ts:PATCH` | Any value in `ALL_STATUSES` | Directly write any canonical status; `closed_manual` cancels pending DM/FU | Updates lead and related queues | Deal route, Tracker, agents | Add a canonical transition map and validation helper. Preserve API behavior initially via shadow/diagnostic use unless enforcing it is demonstrably behavior-preserving. `closed_manual` is manual-only. |
| Deal closure | `src/app/api/deals/route.ts:POST` | Valid deal linked to lead | Lead becomes `closed` | Inserts deal; updates lead | Manual PATCH | `closed` is automated/service transition from deal creation and terminal for automated outreach. Deal persistence stays in deal service. |
| Queue/display status | DM queue and lifecycle/pipeline UI | `dm_queue.status`, canonical lead statuses | Queue/render classification | Queue writes/UI only | Stored lifecycle status | `dm_queued` is not and must not become a lead status/action. |

## Current stored status transitions observed

| From | To | Current source | Nature |
|---|---|---|---|
| absent | `new` | Finder insert RPC | Automated discovery |
| absent | `researched` | Manual/CSV `createLead` | Manual/import creation |
| `new` | `researched` | Researcher / legacy Enricher | Automated research completion |
| `new` | `dead` | Legacy Enricher no-email/error | Automated terminal classification in legacy path |
| `researched` | `email_ready` | Initial-email router / Writer | Automated content materialization |
| `researched` | `dead` | Writer missing email | Automated ineligibility |
| `email_ready` | `researched` | Writer stale-draft repair; data-quality repair | Automated repair |
| `email_ready` | `contacted` | Sender, bulk/manual send, mark-initial-sent | Automated or explicit manual execution |
| `contacted` | `replied` | Tracker inbound receipt | Automated deterministic receipt handling |
| `dead` | `replied` | Tracker late inbound receipt | Automated deterministic late-reply recovery |
| `contacted` | `dead` | Follow-up or Reactivation terminal timing | Automated |
| any accepted current status | any canonical status | General PATCH APIs | Manual; currently unrestricted |
| any non-closed lead | `closed` | Deal creation | Deterministic service action |
| any accepted current status | `closed_manual` | Manual PATCH | Manual-only; cancels queued DM/FU |

No code path stores `dm_queued`. `closed_won` is not a canonical V2 status and is represented by `closed`.

## Inputs that the engine must normalize

The audit establishes these required facts; complete database rows are not required:

- lead identity, canonical status, normalized email presence;
- persisted outreach/delivery suppression and recipient-ownership conflict result;
- duplicate candidate/lead fact when the caller is evaluating discovery;
- initial-email mode (`template` or `ai_personalised`), including an import snapshot when present;
- research completeness relevant to the selected mode;
- category/template availability, template placeholder readiness, and whether missing template data is researchable;
- one summarized current initial-email fact (missing, pending, delivered, uncertain/sync-failed);
- sent timestamps/booleans for initial, FU1, FU2, FU3, and reactivation;
- normalized latest reply classification (future classifier input only), inbound-reply presence, and deal/closed state;
- configured FU/reactivation/dead intervals and a caller-supplied `asOf` time;
- explicit manual override intent, when a manual route is evaluating a transition.

## Side-effect boundary

The following remain outside the pure engine:

- Supabase queries and mutations;
- Trigger schedules, stage sequencing, quotas, retries, and concurrency;
- AI research/writing and category-template rendering;
- Resend/Hostinger/provider operations;
- recipient claims, distributed locks, durable send intents, and idempotency recovery;
- Finder atomic dedupe/insert RPCs;
- activity logging and queue cancellation.

The engine returns an action, stable reason code, the deterministic input keys used, and optional execution metadata. An executor/service must re-check irreversible-action safety at execution time.

## Known inconsistencies to classify in shadow comparisons

1. Template-mode leads currently still pass through the Researcher batch because eligibility is only `status='new'`; research itself is reduced to contact discovery. A template lead whose required values and email already exist can safely skip research under the Prompt 9 intent. This is an **EXPECTED V2 CONSOLIDATION**, not silent behavior drift.
2. `settingsDefaults.ts` describes reactivation as days after dead, while live agent/RPC logic measures `reactivation_delay_days` from the initial email and requires FU3. The engine must preserve executed code semantics (default 60 days from initial) and document the description mismatch.
3. Lifecycle RPC may label all-FU-complete leads as reactivation even before due, while the engine will return `WAIT` until due with a stable `REACTIVATION_NOT_DUE` reason. The date/eligibility remains equivalent; this is an **EXPECTED V2 CONSOLIDATION** of display label versus executable action.
4. General PATCH APIs accept every canonical target from every source status. The transition map will mark forbidden/automated/manual-only edges, but enforcement should initially be shadow-only to avoid an unreviewed customer-facing behavior change.
5. Obvious out-of-office mail is currently ignored by Tracker before any reply state is persisted. The normalized `OUT_OF_OFFICE` boundary therefore maps to `WAIT`; semantic classification itself remains deferred.

## Audit gate

This baseline inventory is complete for the Prompt 9 minimum sources: Finder, Researcher, Writer, `email_ready`, Sender, Follow-up, Reactivation, reply processing, suppression, lifecycle display, manual transitions, template/personalized mode, inbound replies, and closed/dead behavior. Implementation may now proceed against this documented baseline.
