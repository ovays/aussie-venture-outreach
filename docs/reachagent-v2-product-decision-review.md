# ReachAgent V2 product decision review

Date: 17 September 2026 (Australia/Sydney)

Status: **PROMPT 15.5 PRODUCT DECISION REVIEW READY**

This review uses only the retained Prompt 15 comparison reports and the local
Decision Engine, Orchestrator, and service code. It does not use the deleted
production snapshot. No production system, database, provider, Finder job, email
sender, or Trigger deployment was accessed.

## Executive result

The 72 `PRODUCT_DECISION_REQUIRED` cases reduce to **three root decisions**. Only
two are genuine unresolved product policies:

| Decision | Root cause | Cases | Side-effect blockers | Evidence type |
|---|---|---:|---:|---|
| PD-01 | Whether null-category contacted leads may continue follow-ups | 30 | 19 | Genuine product policy plus insufficient content facts |
| PD-02 | Whether null-category contacted leads may be reactivated | 38 | 19 | Genuine product policy plus insufficient content facts |
| PD-03 | Whether contacted/template-ready leads should regenerate an initial email | 4 | 0 | Comparison-model limitation / historical V1 inconsistency |
| **Total** |  | **72** | **38** |  |

All 72 leads are `contacted` and in template mode. The central divergence is
ordering: the synthesized V1-intent comparator evaluates template readiness before
contacted lifecycle scheduling, while V2 gives contacted lifecycle state precedence.
The comparison report proves the action differences, but does not prove that V1
actually performed the synthesized legacy actions.

No real-comparison evidence conflicts with the already-approved V2 timing,
precedence, uncertainty, architecture, or zero-AI template rules.

## Safe ambiguities versus canary blockers

### Safe / no-side-effect ambiguities

- **11 PD-01 cases:** V1 intent is `MANUAL_REVIEW`; V2 is `WAIT / FOLLOWUP_NOT_DUE`.
- **19 PD-02 cases:** V1 intent is `MANUAL_REVIEW`; V2 is `WAIT / REACTIVATION_NOT_DUE`.
- **4 PD-03 cases:** V1 intent is `GENERATE_INITIAL`; V2 is `WAIT`.
- **Total safe cases: 34.**

These differences do not make V2 send or change durable state in the sampled
comparison. They should not be treated as operational blockers merely because the
legacy classifier assigns the generic `PRODUCT_DECISION_REQUIRED` label.

### Canary blockers

- **19 PD-01 cases:** V2 would send a follow-up: FU1 4, FU2 11, FU3 4.
- **19 PD-02 cases:** V2 would reactivate the lead.
- **Total side-effect blockers: 38.**

No sampled product-decision case proposes `MARK_DEAD`, `HANDLE_REPLY`, or another
durable-state action. Those actions still matter when evaluating any global
configuration workaround—for example, disabling reactivation can make V2 mark a
completed sequence dead.

## PD-01 — Null-category follow-up continuation

- **Concise description:** Decide whether an already-contacted lead may receive
  scheduled follow-ups when its current category is null.
- **Affected lead count:** 30.
- **Side-effect blocker count:** 19.
- **Statuses involved:** `contacted` only.
- **Current V1 behavior:** synthesized V1 intent returns `MANUAL_REVIEW` because
  template mode with no available category template is evaluated before contacted
  sequence scheduling.
- **Current V2 behavior:** 4 `SEND_FOLLOWUP_1`, 11 `SEND_FOLLOWUP_2`, 4
  `SEND_FOLLOWUP_3`, and 12 `WAIT / FOLLOWUP_NOT_DUE`.
- **Why they differ:** V2 treats the sent initial email and contacted lifecycle as
  governing facts. Current category/template readiness gates initial generation,
  not the continuation of an established sequence.
- **What remains ambiguous:** The retained sanitized report does not say whether
  follow-up content is already stored, category-neutral, or dependent on the
  missing category. It also does not preserve the category/campaign used for the
  original initial email. This is insufficient snapshot evidence, not proof of a
  product rule.

### Options

- **Option A — Continue the contacted sequence.** Keep approved V2 scheduling and
  allow follow-ups based on sent history even when current category is null.
- **Option B — Require a valid category for follow-up sends.** Route null-category
  leads to manual review or exclude them until categorized. This introduces a new
  contacted-sequence content gate without changing approved timing rules.
- **Option C — Use preserved campaign/template context or a category-neutral
  fallback.** Continue only when send-time context or explicitly approved generic
  content is available. This is the strongest long-term model but the retained
  facts cannot prove that such context exists today.

- **Safest default for a canary:** Option B—exclude null-category follow-up sends or
  route them to manual review. Do not reinterpret the 12 not-due waits as blockers.
- **Long-term SaaS implication:** Campaign/template identity should be snapshotted
  at initial send. A tenant or campaign policy can then choose preserved context,
  current-category enforcement, or an approved neutral fallback without allowing
  mutable classification to silently rewrite an active sequence.
- **Can the safest default unblock Prompt 16?** It removes these **19** blockers if
  enforceable as a canary cohort restriction. There is no existing category-specific
  runtime setting, so global configuration alone does not cleanly enforce it.

## PD-02 — Null-category reactivation

- **Concise description:** Decide whether an already-contacted lead may be
  reactivated after the approved 60-day interval when its current category is null.
- **Affected lead count:** 38.
- **Side-effect blocker count:** 19.
- **Statuses involved:** `contacted` only.
- **Current V1 behavior:** synthesized V1 intent returns `MANUAL_REVIEW` before
  reaching reactivation scheduling.
- **Current V2 behavior:** 19 `REACTIVATE / REACTIVATION_READY` and 18
  `WAIT / REACTIVATION_NOT_DUE`.
- **Why they differ:** V2 gives completed sequence history and the approved
  initial-send-based reactivation schedule precedence over current template
  availability.
- **What remains ambiguous:** The retained report cannot establish whether the
  reactivation content has a safe null-category fallback, whether original campaign
  context survives, or why the current category is absent. Reactivation resumes
  contact after a long interval, so this is a distinct product decision from an
  in-sequence follow-up.

### Options

- **Option A — Permit reactivation.** Preserve the approved 60-day rule and allow
  reactivation from historical sequence facts regardless of current category.
- **Option B — Require category or preserved campaign context.** Exclude or
  manually review null-category reactivations until content provenance is known.
- **Option C — Disable reactivation for the canary or tenant.** This uses an
  existing broad setting but changes all reactivation behavior and may lead V2 to
  `MARK_DEAD`; it is not a category-specific resolution.

- **Safest default for a canary:** Option B—exclude null-category reactivations.
  Prefer cohort restriction over globally disabling reactivation.
- **Long-term SaaS implication:** Reactivation needs an explicit tenant/campaign
  policy because it resumes a dormant relationship. The durable model should use
  preserved campaign context, approved neutral content, current-category review,
  or tenant-level disablement explicitly.
- **Can the safest default unblock Prompt 16?** It removes these **19** blockers if
  enforceable as a canary cohort restriction. `reactivation_enabled=false` only
  partially helps and can introduce `MARK_DEAD`; it does not solve PD-01.

## PD-03 — Initial regeneration after contact

- **Concise description:** Confirm that template readiness must not automatically
  regenerate initial content for a lead already in the contacted lifecycle.
- **Affected lead count:** 4.
- **Side-effect blocker count:** 0.
- **Statuses involved:** `contacted` only; all four are manual-source,
  category-present, and template-ready.
- **Current V1 behavior:** synthesized V1 intent returns `GENERATE_INITIAL` because
  its template branch runs before contacted lifecycle handling.
- **Current V2 behavior:** 3 `WAIT / REACTIVATION_NOT_DUE` and 1
  `WAIT / FOLLOWUP_NOT_DUE`.
- **Why they differ:** The legacy comparison model ignores the already-sent initial
  when its earlier template branch returns. V2 uses lifecycle state first and does
  not regenerate an initial email automatically.
- **Evidence assessment:** This is a comparison-model limitation and likely a
  historical V1-intent inconsistency, not evidence that the approved V2 lifecycle
  rule is wrong. The report contains derived V1 intent, not observed generation.

### Options

- **Option A — Preserve V2 lifecycle ordering.** Never auto-regenerate an initial
  email after contact.
- **Option B — Permit explicit, audited operator regeneration only.** Keep it out
  of automatic Decision Engine next-action selection.
- **Option C — Reproduce legacy comparator ordering.** Automatically regenerate
  whenever a contacted lead is template-ready; this conflicts with lifecycle truth
  and risks duplicate or stale drafts.

- **Safest default for a canary:** Option A.
- **Long-term SaaS implication:** Lifecycle truth must outrank mutable template
  readiness. Repair/regeneration should be a separate audited operator operation.
- **Can the safest default unblock Prompt 16?** These four are already non-blocking;
  approving Option A removes false review noise but removes **0** side-effect blockers.

## Evidence limitations and classification corrections

- `deriveLegacyIntendedAction` is a synthesized comparison model, not a production
  execution log. Its template-mode branch precedes contacted scheduling.
- The generic comparator labels every unrecognized difference
  `PRODUCT_DECISION_REQUIRED`; it does not distinguish safe `WAIT` differences,
  null-category policy, or contacted lifecycle ordering.
- The sanitized retained report intentionally lacks message content, original
  campaign/template identity, detailed content readiness, and the reason category
  data is absent. Those missing facts prevent a defensible claim that null-category
  follow-up or reactivation content is safe.
- The four PD-03 cases should be treated as comparison-model limitation / historical
  V1 inconsistency rather than a new runtime product rule.
- The 30 safe null-category waits remain explained by PD-01/PD-02 ordering, but they
  do not require a canary side-effect decision today.

## Canary-readiness arithmetic

| Proposed decision applied | Cases explained | Blockers removed | Blockers remaining |
|---|---:|---:|---:|
| None | 0 | 0 | 38 |
| PD-01 safe default only | 30 | 19 | 19 |
| PD-02 safe default only | 38 | 19 | 19 |
| PD-03 safe default only | 4 | 0 | 38 |
| PD-01 + PD-02 safe defaults | 68 | 38 | 0 |
| PD-01 + PD-02 + PD-03 safe defaults | 72 | 38 | 0 |

- Total product-decision cases: **72**.
- Total side-effect blockers: **38**.
- Cases explained by root decisions: **30 + 38 + 4 = 72**.
- Safe/no-side-effect cases: **34**.
- There is a canary configuration in the broad sense—curate or gate the canary so
  null-category contacted leads cannot execute follow-up or reactivation actions,
  while preserving the approved Decision Engine/Orchestrator architecture.
- There is **not** a clean existing settings-only configuration for that policy.
  Global quota/delay/disable settings either affect all leads or can produce other
  actions such as `MARK_DEAD`.
- Prompt 16 remains **not safe to start** until PD-01 and PD-02 are chosen and an
  enforceable cohort/policy boundary is separately approved. No implementation is
  performed by this review.

## Decision record requested

Only these choices are needed:

1. **PD-01:** Continue null-category follow-ups, require category/manual review, or
   require preserved/neutral content context?
2. **PD-02:** Permit null-category reactivation, require category/preserved context,
   or disable it more broadly?
3. **PD-03:** Confirm V2 lifecycle ordering, with optional explicit operator-only
   regeneration?

Prompt 16 was not started.

## Approved decisions and Prompt 15.6 implementation

- **PD-01 approved:** A due FU1/FU2/FU3 without usable category context returns
  `MANUAL_REVIEW / CATEGORY_CONTEXT_REQUIRED`. No category is invented and no AI
  fallback is used.
- **PD-02 approved:** A due reactivation without usable category context returns
  `MANUAL_REVIEW / CATEGORY_CONTEXT_REQUIRED`. No category is regenerated from
  incomplete history.
- **PD-03 approved:** Contacted lifecycle state remains authoritative; V2 never
  automatically regenerates initial outreach after contact.

Usable category context is deterministic and stricter than ID presence. The live
context loader sets `hasUsableCategoryContext` only when `leads.category_id` is
non-null **and** the already-loaded `categories!leads_category_id_fkey` relation
resolves. Null IDs, orphaned/invalid IDs, absent relations, and missing context fail
closed. Template availability is not used as a proxy, no new database lookup was
added, and no preserved/category-neutral exception exists in the current context.

Implementation status: **complete and locally verified**.

- Blockers before: **38**.
- Blockers after: **0**.
- Remaining `PRODUCT_DECISION_REQUIRED`: **34**, all non-side-effect/documentation-only.
- `BUG_IN_NEW_ENGINE`: **0**.
- Full Decision Engine suite: **PASS** — 43 pure cases, 5 transition assertions,
  4 shadow comparisons, 5 integrated execution paths, bounded batch 100.
- Retained-artifact Prompt 15.5 replay: **PASS** — 72 reviewed, 38 converted to
  manual review, 34 non-side-effect rows remain, no production access, snapshot not
  recreated.
- Shadow-readiness suite: **PASS** — 29 synthetic cohorts; read-only and
  deterministic architecture boundaries preserved.
- Typecheck: **PASS**.

Prompt 16 is now safe to start from the Prompt 15.6 safety-gate perspective because
all known side-effect blockers fail closed. Prompt 16 was **not** started, and its
own launch controls and authorization remain required.
