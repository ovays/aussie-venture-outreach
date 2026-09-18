/**
 * Prompt 15 offline V1-vs-V2 Decision Engine comparison.
 *
 * Reads a sanitized snapshot produced by scripts/prompt15-sanitized-snapshot.sql,
 * rebuilds a LeadDecisionContext from derived facts only, and compares the V1
 * intended action against the V2 Decision Engine action. Nothing here touches a
 * network, a database, an AI provider, or an email provider.
 *
 * Usage:
 *   tsx scripts/prompt15-offline-comparison.ts <snapshot.json> [--write-report]
 *                                              [--source production|fixture]
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { compareDecisionWithLegacy } from '@/domain/decision-engine/shadow'
import type { ShadowDifferenceClassification } from '@/domain/decision-engine/shadow'
import { decideNextAction } from '@/domain/decision-engine/decide'
import { DECISION_ACTIONS } from '@/domain/decision-engine/types'
import { isCanonicalLeadStatus } from '@/domain/decision-engine/transitions'
import type {
  DecisionEmailStage,
  EmailStageState,
  LeadDecisionContext,
} from '@/domain/decision-engine/types'
import { DEFAULT_DECISION_SCHEDULE } from '@/domain/decision-engine/types'
import { isInitialEmailMode } from '@/lib/settingsDefaults'
import { validateSnapshotRows } from './prompt15-snapshot-safety'

export interface SnapshotRow {
  lead_id: string
  status: string
  category_id: string | null
  manual_source: boolean
  category_id_present: boolean
  has_email: boolean
  suppressed: boolean
  duplicate: boolean
  recipient_ownership: 'owned_by_lead' | 'owned_by_other' | 'unclaimed'
  deal_state: 'none' | 'active' | 'closed'
  initial_email_mode: string
  contact_discovery_complete: boolean
  personalisation_complete: boolean
  can_supply_template_fields: boolean
  template_available: boolean
  required_template_placeholders: string[]
  required_template_data_available: boolean
  initial_email_state: EmailStageState
  initial_sent_at: string | null
  follow_up_1_state: EmailStageState
  follow_up_1_sent_at: string | null
  follow_up_2_state: EmailStageState
  follow_up_2_sent_at: string | null
  follow_up_3_state: EmailStageState
  follow_up_3_sent_at: string | null
  reply_received: boolean
  reply_classification: string | null
  reactivation_enabled: boolean
  reactivation_sent_at: string | null
  follow_up_1_days: number
  follow_up_2_days: number
  follow_up_3_days: number
  dead_lead_days: number
  reactivation_delay_days: number
  dead_after_reactivation_days: number
  as_of: string
  cohorts: string[]
  population_total: number
  population_status_total: number
  population_excluded_status_total: number
}

const STAGE_STATES: readonly EmailStageState[] = ['missing', 'pending', 'sent', 'uncertain']

function stage(state: EmailStageState, sentAt: string | null): DecisionEmailStage {
  assert.ok(STAGE_STATES.includes(state), `Unknown email stage state: ${state}`)
  if (state === 'sent') assert.ok(sentAt, 'A sent stage requires a timestamp')
  return { state, sentAt: state === 'sent' ? sentAt : null }
}

function positiveInteger(value: number, fallback: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback
}

/**
 * Rebuilds the executable decision context. Mirrors
 * src/domain/shadow-readiness/derived-context-loader.ts so the offline run and
 * the rehearsed shadow reader agree on every derived fact.
 */
export function contextFromSnapshotRow(row: SnapshotRow): LeadDecisionContext {
  assert.ok(isCanonicalLeadStatus(row.status), `Lead ${row.lead_id} has non-canonical status ${row.status}`)
  assert.ok(isInitialEmailMode(row.initial_email_mode), `Lead ${row.lead_id} has unknown mode ${row.initial_email_mode}`)
  assert.equal(row.reply_classification, null, 'V1 reply bodies are never classified offline')
  return {
    leadId: row.lead_id,
    status: row.status,
    // The snapshot carries presence only; the engine reads truthiness, never the value.
    email: row.has_email ? 'redacted@shadow.invalid' : null,
    duplicate: row.duplicate,
    suppressed: row.suppressed,
    dealState: row.deal_state,
    initialEmailMode: row.initial_email_mode,
    research: {
      contactDiscoveryComplete: row.contact_discovery_complete,
      personalisationComplete: row.personalisation_complete,
      canSupplyTemplateFields: row.can_supply_template_fields,
    },
    template: {
      available: row.template_available,
      requiredDataAvailable: row.required_template_data_available,
    },
    initialEmail: stage(row.initial_email_state, row.initial_sent_at),
    followUps: {
      followUp1: stage(row.follow_up_1_state, row.follow_up_1_sent_at),
      followUp2: stage(row.follow_up_2_state, row.follow_up_2_sent_at),
      followUp3: stage(row.follow_up_3_state, row.follow_up_3_sent_at),
    },
    reply: { received: row.reply_received, classification: null },
    reactivation: { enabled: row.reactivation_enabled, sentAt: row.reactivation_sent_at },
    schedule: {
      followUp1Days: positiveInteger(row.follow_up_1_days, DEFAULT_DECISION_SCHEDULE.followUp1Days),
      followUp2Days: positiveInteger(row.follow_up_2_days, DEFAULT_DECISION_SCHEDULE.followUp2Days),
      followUp3Days: positiveInteger(row.follow_up_3_days, DEFAULT_DECISION_SCHEDULE.followUp3Days),
      deadLeadDays: positiveInteger(row.dead_lead_days, DEFAULT_DECISION_SCHEDULE.deadLeadDays),
      reactivationDelayDays: positiveInteger(row.reactivation_delay_days, DEFAULT_DECISION_SCHEDULE.reactivationDelayDays),
      deadAfterReactivationDays: positiveInteger(row.dead_after_reactivation_days, DEFAULT_DECISION_SCHEDULE.deadAfterReactivationDays),
    },
    asOf: row.as_of,
    manualOverride: null,
    operationalFacts: {
      categoryIdPresent: row.category_id_present,
      hasUsableCategoryContext: row.category_id_present,
      manualSource: row.manual_source,
      recipientOwnership: row.recipient_ownership,
      openDuplicateFlag: row.duplicate,
    },
  }
}

export interface ComparisonCase {
  leadId: string
  status: string
  mode: string
  categoryPresent: boolean
  cohorts: string[]
  v1Action: string
  v2Action: string
  v2ReasonCode: string
  classification: ShadowDifferenceClassification
  reason: string
  canaryBlocker: boolean
}

/**
 * A difference is a canary blocker only when V2 would act where V1 would not,
 * or would act differently in a way that produces an outbound side effect.
 */
const SIDE_EFFECT_ACTIONS = new Set([
  'SEND_INITIAL', 'GENERATE_INITIAL', 'SEND_FOLLOWUP_1', 'SEND_FOLLOWUP_2',
  'SEND_FOLLOWUP_3', 'REACTIVATE', 'MARK_DEAD', 'RESEARCH',
])

export function compareSnapshot(rows: readonly SnapshotRow[]): ComparisonCase[] {
  return rows.map((row) => {
    const context = contextFromSnapshotRow(row)
    const comparison = compareDecisionWithLegacy(context)
    const differs = comparison.engine.action !== comparison.legacyAction
    return {
      leadId: row.lead_id,
      status: row.status,
      mode: row.initial_email_mode,
      categoryPresent: row.category_id_present,
      cohorts: row.cohorts,
      v1Action: comparison.legacyAction,
      v2Action: comparison.engine.action,
      v2ReasonCode: comparison.engine.reasonCode,
      classification: comparison.classification,
      reason: comparison.note,
      canaryBlocker:
        differs
        && comparison.classification !== 'EXPECTED_V2_CONSOLIDATION'
        && comparison.classification !== 'BUG_IN_OLD_LOGIC'
        && SIDE_EFFECT_ACTIONS.has(comparison.engine.action),
    }
  })
}

// ── Rule verification ───────────────────────────────────────────────────────
// The sixteen Prompt 15 rules. Each is asserted against deterministic synthetic
// contexts so coverage does not depend on which leads production happens to
// hold, and then cross-checked against the real sample where instances exist.

const BASE_ASOF = '2026-09-17T00:00:00.000Z'
const daysBefore = (days: number) => new Date(Date.parse(BASE_ASOF) - days * 86_400_000).toISOString()

function syntheticContext(overrides: Partial<LeadDecisionContext> = {}): LeadDecisionContext {
  const missing: DecisionEmailStage = { state: 'missing', sentAt: null }
  return {
    leadId: '00000000-0000-4000-8000-00000000rule',
    status: 'new',
    email: 'redacted@shadow.invalid',
    duplicate: false,
    suppressed: false,
    dealState: 'none',
    initialEmailMode: 'ai_personalised',
    research: { contactDiscoveryComplete: true, personalisationComplete: false, canSupplyTemplateFields: false },
    template: { available: false, requiredDataAvailable: false },
    initialEmail: missing,
    followUps: { followUp1: missing, followUp2: missing, followUp3: missing },
    reply: { received: false, classification: null },
    reactivation: { enabled: true, sentAt: null },
    schedule: { ...DEFAULT_DECISION_SCHEDULE },
    asOf: BASE_ASOF,
    manualOverride: null,
    operationalFacts: { categoryIdPresent: true, hasUsableCategoryContext: true, manualSource: false, recipientOwnership: 'unclaimed', openDuplicateFlag: false },
    ...overrides,
  }
}

const sent = (days: number): DecisionEmailStage => ({ state: 'sent', sentAt: daysBefore(days) })

export interface RuleResult { id: number; rule: string; pass: boolean; detail: string }

export function verifyRules(cases: readonly ComparisonCase[]): RuleResult[] {
  const results: RuleResult[] = []
  const check = (id: number, rule: string, fn: () => string) => {
    try {
      results.push({ id, rule, pass: true, detail: fn() })
    } catch (error) {
      results.push({ id, rule, pass: false, detail: error instanceof Error ? error.message : String(error) })
    }
  }
  const act = (overrides: Partial<LeadDecisionContext>) => decideNextAction(syntheticContext(overrides))
  const contacted = (days: number, extra: Partial<LeadDecisionContext> = {}) =>
    ({ status: 'contacted' as const, initialEmail: sent(days), ...extra })

  check(1, 'duplicate/suppression precedence', () => {
    // Both must win over an otherwise due follow-up and over reply handling.
    assert.equal(act({ duplicate: true, ...contacted(30), reply: { received: true, classification: null } }).action, 'STOP')
    assert.equal(act({ duplicate: true, ...contacted(30) }).reasonCode, 'DUPLICATE_LEAD')
    assert.equal(act({ suppressed: true, ...contacted(30) }).reasonCode, 'SUPPRESSED')
    assert.equal(act({ operationalFacts: { categoryIdPresent: true, hasUsableCategoryContext: true, manualSource: false, recipientOwnership: 'unclaimed', openDuplicateFlag: true }, ...contacted(30) }).reasonCode, 'DUPLICATE_LEAD')
    // Duplicate outranks suppression only in reason ordering; both STOP.
    assert.equal(act({ duplicate: true, suppressed: true, status: 'closed' }).reasonCode, 'DUPLICATE_LEAD')
    return 'Duplicate and suppression STOP ahead of reply, deal, follow-up, and terminal handling.'
  })

  check(2, 'terminal state handling', () => {
    for (const status of ['closed', 'closed_manual', 'dead'] as const) {
      const decision = act({ status })
      assert.equal(decision.action, 'STOP')
      assert.equal(decision.reasonCode, 'TERMINAL_STATUS')
    }
    assert.equal(act({ status: 'contacted', dealState: 'closed', initialEmail: sent(90) }).reasonCode, 'TERMINAL_STATUS')
    return 'closed, closed_manual, dead, and a closed deal all STOP with TERMINAL_STATUS.'
  })

  check(3, 'reply handling', () => {
    assert.equal(act({ status: 'replied', reply: { received: true, classification: null } }).reasonCode, 'REPLY_CLASSIFICATION_REQUIRED')
    assert.equal(act({ ...contacted(30), reply: { received: true, classification: null } }).action, 'HANDLE_REPLY')
    assert.equal(act({ ...contacted(30), reply: { received: true, classification: 'UNSUBSCRIBE' } }).reasonCode, 'UNSUBSCRIBED')
    assert.equal(act({ ...contacted(30), reply: { received: true, classification: 'OUT_OF_OFFICE' } }).action, 'WAIT')
    // A reply always beats a due follow-up.
    assert.notEqual(act({ ...contacted(30), reply: { received: true, classification: null } }).action, 'SEND_FOLLOWUP_1')
    return 'Replies hand off before follow-up scheduling; unsubscribe stops and out-of-office waits.'
  })

  check(4, 'interested/negotiating/closed handling', () => {
    assert.equal(act({ status: 'interested' }).reasonCode, 'ACTIVE_DEAL_STATUS')
    assert.equal(act({ status: 'negotiating' }).reasonCode, 'ACTIVE_DEAL_STATUS')
    assert.equal(act({ status: 'contacted', dealState: 'active', initialEmail: sent(30) }).reasonCode, 'ACTIVE_DEAL_STATUS')
    assert.equal(act({ status: 'closed' }).reasonCode, 'TERMINAL_STATUS')
    return 'Active-deal statuses STOP without any outbound action.'
  })

  check(5, 'template-ready flow', () => {
    const decision = act({ initialEmailMode: 'template', template: { available: true, requiredDataAvailable: true } })
    assert.equal(decision.action, 'GENERATE_INITIAL')
    assert.equal(decision.reasonCode, 'TEMPLATE_READY')
    assert.equal(decision.metadata?.generationMode, 'template')
    assert.equal(act({ initialEmailMode: 'template', template: { available: false, requiredDataAvailable: false } }).reasonCode, 'TEMPLATE_CONFIGURATION_INVALID')
    assert.equal(act({ initialEmailMode: 'template', template: { available: true, requiredDataAvailable: false } }).reasonCode, 'TEMPLATE_DATA_UNAVAILABLE')
    assert.equal(act({ initialEmailMode: 'template', template: { available: true, requiredDataAvailable: false }, research: { contactDiscoveryComplete: true, personalisationComplete: false, canSupplyTemplateFields: true } }).reasonCode, 'TEMPLATE_RESEARCH_REQUIRED')
    return 'Template mode generates only when the template and its required data are both present.'
  })

  check(6, 'personalised research flow', () => {
    assert.equal(act({}).reasonCode, 'PERSONALIZED_RESEARCH_REQUIRED')
    const ready = act({ status: 'researched', research: { contactDiscoveryComplete: true, personalisationComplete: true, canSupplyTemplateFields: false } })
    assert.equal(ready.action, 'GENERATE_INITIAL')
    assert.equal(ready.metadata?.generationMode, 'ai_personalised')
    assert.equal(act({ status: 'researched', email: null, research: { contactDiscoveryComplete: false, personalisationComplete: true, canSupplyTemplateFields: false } }).reasonCode, 'MISSING_EMAIL')
    return 'Personalised mode researches first, then generates, and stops when no address exists.'
  })

  check(7, 'email_ready + pending initial => SEND_INITIAL', () => {
    const decision = act({ status: 'email_ready', initialEmail: { state: 'pending', sentAt: null } })
    assert.equal(decision.action, 'SEND_INITIAL')
    assert.equal(decision.reasonCode, 'INITIAL_CONTENT_READY')
    // email_ready without content must not silently regenerate.
    assert.equal(act({ status: 'email_ready' }).action, 'MANUAL_REVIEW')
    return 'A pending initial pitch is sent, never regenerated; email_ready without content needs review.'
  })

  check(8, 'FU1 = 7 days from initial', () => {
    assert.equal(act(contacted(6)).reasonCode, 'FOLLOWUP_NOT_DUE')
    assert.equal(act(contacted(7)).action, 'SEND_FOLLOWUP_1')
    return 'Day 6 waits, day 7 sends follow-up 1, measured from the initial send.'
  })

  check(9, 'FU2 = 14 days from initial', () => {
    assert.equal(act(contacted(13, { followUps: { followUp1: sent(6), followUp2: { state: 'missing', sentAt: null }, followUp3: { state: 'missing', sentAt: null } } })).reasonCode, 'FOLLOWUP_NOT_DUE')
    assert.equal(act(contacted(14, { followUps: { followUp1: sent(7), followUp2: { state: 'missing', sentAt: null }, followUp3: { state: 'missing', sentAt: null } } })).action, 'SEND_FOLLOWUP_2')
    return 'Follow-up 2 is due at 14 days from the initial send, not from follow-up 1.'
  })

  check(10, 'FU3 = 21 days from initial', () => {
    assert.equal(act(contacted(20, { followUps: { followUp1: sent(13), followUp2: sent(6), followUp3: { state: 'missing', sentAt: null } } })).reasonCode, 'FOLLOWUP_NOT_DUE')
    assert.equal(act(contacted(21, { followUps: { followUp1: sent(14), followUp2: sent(7), followUp3: { state: 'missing', sentAt: null } } })).action, 'SEND_FOLLOWUP_3')
    return 'Follow-up 3 is due at 21 days from the initial send.'
  })

  check(11, 'reactivation = 60 days from initial send', () => {
    const all = (base: number) => ({ followUp1: sent(base - 7), followUp2: sent(base - 14), followUp3: sent(base - 21) })
    assert.equal(act(contacted(59, { followUps: all(59) })).reasonCode, 'REACTIVATION_NOT_DUE')
    const due = act(contacted(60, { followUps: all(60) }))
    assert.equal(due.action, 'REACTIVATE')
    assert.equal(due.metadata?.daysSinceInitial, 60)
    // Explicitly anchored to the initial send, not to follow-up 3.
    assert.equal(act(contacted(59, { followUps: { followUp1: sent(52), followUp2: sent(45), followUp3: sent(38) } })).action, 'WAIT')
    assert.equal(act(contacted(30, { followUps: all(30), reactivation: { enabled: false, sentAt: null } })).action, 'MARK_DEAD')
    return 'Reactivation is measured 60 days from the initial send; disabled reactivation ends the sequence instead.'
  })

  check(12, 'post-reactivation dead threshold = 14 days', () => {
    const all = { followUp1: sent(70), followUp2: sent(63), followUp3: sent(56) }
    assert.equal(act(contacted(80, { followUps: all, reactivation: { enabled: true, sentAt: daysBefore(13) } })).reasonCode, 'REACTIVATION_ALREADY_SENT')
    const dead = act(contacted(80, { followUps: all, reactivation: { enabled: true, sentAt: daysBefore(14) } }))
    assert.equal(dead.action, 'MARK_DEAD')
    assert.equal(dead.reasonCode, 'REACTIVATION_DEADLINE_REACHED')
    return 'Day 13 after reactivation waits; day 14 marks the lead dead.'
  })

  check(13, 'send uncertainty => MANUAL_REVIEW', () => {
    assert.equal(act({ status: 'email_ready', initialEmail: { state: 'uncertain', sentAt: null } }).reasonCode, 'INITIAL_SEND_UNCERTAIN')
    assert.equal(act({ status: 'contacted', initialEmail: { state: 'uncertain', sentAt: null } }).reasonCode, 'INITIAL_SEND_UNCERTAIN')
    const fu = act(contacted(30, { followUps: { followUp1: { state: 'uncertain', sentAt: null }, followUp2: { state: 'missing', sentAt: null }, followUp3: { state: 'missing', sentAt: null } } }))
    assert.equal(fu.action, 'MANUAL_REVIEW')
    assert.equal(fu.reasonCode, 'FOLLOWUP_SEND_UNCERTAIN')
    return 'Unresolved email_sync_failed sends always stop for review instead of resending.'
  })

  check(14, 'null category handling', () => {
    // No category means no template, which must never be treated as ready.
    const decision = act({ initialEmailMode: 'template', template: { available: false, requiredDataAvailable: false }, operationalFacts: { categoryIdPresent: false, hasUsableCategoryContext: false, manualSource: false, recipientOwnership: 'unclaimed', openDuplicateFlag: false } })
    assert.equal(decision.action, 'MANUAL_REVIEW')
    assert.equal(decision.reasonCode, 'TEMPLATE_CONFIGURATION_INVALID')
    // Personalised mode remains unaffected by a missing category.
    assert.equal(act({ operationalFacts: { categoryIdPresent: false, hasUsableCategoryContext: false, manualSource: false, recipientOwnership: 'unclaimed', openDuplicateFlag: false } }).action, 'RESEARCH')
    const sampled = cases.filter((item) => !item.categoryPresent)
    assert.ok(sampled.every((item) => item.v2Action !== 'GENERATE_INITIAL' || item.mode === 'ai_personalised'),
      'A sampled lead without a category reached template generation')
    return `Null-category leads never reach template generation (${sampled.length} sampled instances).`
  })

  check(15, 'no GENERATE_FOLLOWUP', () => {
    assert.ok(!(DECISION_ACTIONS as readonly string[]).includes('GENERATE_FOLLOWUP'), 'GENERATE_FOLLOWUP is still a declared action')
    assert.ok(cases.every((item) => item.v2Action !== 'GENERATE_FOLLOWUP' && item.v1Action !== 'GENERATE_FOLLOWUP'))
    // Follow-up sends carry their own content readiness rather than a separate generate step.
    const decision = act(contacted(7))
    assert.equal(decision.action, 'SEND_FOLLOWUP_1')
    assert.equal(decision.metadata?.contentReady, false)
    return 'GENERATE_FOLLOWUP does not exist; follow-ups are a single send action carrying contentReady.'
  })

  check(16, 'template-ready path remains zero-AI', () => {
    const decision = act({ initialEmailMode: 'template', template: { available: true, requiredDataAvailable: true } })
    assert.equal(decision.metadata?.generationMode, 'template')
    assert.notEqual(decision.action, 'RESEARCH')
    // A template-ready lead must never be routed through research for personalisation.
    assert.equal(act({ status: 'new', initialEmailMode: 'template', template: { available: true, requiredDataAvailable: true }, research: { contactDiscoveryComplete: true, personalisationComplete: false, canSupplyTemplateFields: false } }).action, 'GENERATE_INITIAL')
    const sampled = cases.filter((item) => item.cohorts.includes('template_ready') && item.mode === 'template')
    assert.ok(sampled.every((item) => item.v2Action !== 'RESEARCH'),
      'A template-ready sampled lead was routed to Research')
    return `Template-ready leads generate deterministically with no AI step (${sampled.length} sampled instances).`
  })

  return results
}

// ── Report ──────────────────────────────────────────────────────────────────

const CLASSIFICATIONS: readonly ShadowDifferenceClassification[] = [
  'MATCH', 'EXPECTED_V2_CONSOLIDATION', 'BUG_IN_OLD_LOGIC', 'BUG_IN_NEW_ENGINE', 'PRODUCT_DECISION_REQUIRED',
]

function tally(values: readonly string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((acc, value) => ({ ...acc, [value]: (acc[value] ?? 0) + 1 }), {})
}

export interface ComparisonReport {
  date: string
  timezone: string
  status: string
  source: string
  sampleSize: number
  populationTotal: number | null
  populationExcludedStatusTotal: number | null
  statusDistribution: Record<string, number>
  populationStatusDistribution: Record<string, number>
  modeDistribution: Record<string, number>
  categoryDistribution: Record<string, number>
  cohortCoverage: Record<string, number>
  classifications: Record<string, number>
  differences: ComparisonCase[]
  rules: RuleResult[]
  unresolvedCases: string[]
  canaryBlockers: number
}

export function buildReport(rows: readonly SnapshotRow[], cases: readonly ComparisonCase[], source: string): ComparisonReport {
  const classifications = Object.fromEntries(CLASSIFICATIONS.map((name) => [name, 0])) as Record<string, number>
  for (const item of cases) classifications[item.classification]++
  const populationStatus: Record<string, number> = {}
  for (const row of rows) populationStatus[row.status] = row.population_status_total
  const rules = verifyRules(cases)
  const differences = cases.filter((item) => item.classification !== 'MATCH')
  const unresolved = differences
    .filter((item) => item.classification === 'PRODUCT_DECISION_REQUIRED' || item.classification === 'BUG_IN_NEW_ENGINE')
    .map((item) => `${item.leadId}: ${item.classification} — V1 ${item.v1Action} vs V2 ${item.v2Action} (${item.v2ReasonCode})`)
  const failedRules = rules.filter((rule) => !rule.pass).map((rule) => `Rule ${rule.id} (${rule.rule}) failed: ${rule.detail}`)
  const canaryBlockers = differences.filter((item) => item.canaryBlocker).length
  const pass = classifications.BUG_IN_NEW_ENGINE === 0 && failedRules.length === 0 && rows.length > 0

  return {
    date: new Date().toISOString().slice(0, 10),
    timezone: 'Australia/Sydney',
    status: pass ? 'PROMPT 15 PASS' : 'PROMPT 15 BLOCKED',
    source,
    sampleSize: rows.length,
    populationTotal: rows[0]?.population_total ?? null,
    populationExcludedStatusTotal: rows[0]?.population_excluded_status_total ?? null,
    statusDistribution: tally(rows.map((row) => row.status)),
    populationStatusDistribution: populationStatus,
    modeDistribution: tally(rows.map((row) => row.initial_email_mode)),
    categoryDistribution: tally(rows.map((row) => (row.category_id_present ? 'category_present' : 'category_null'))),
    cohortCoverage: tally(rows.flatMap((row) => row.cohorts)),
    classifications,
    differences,
    rules,
    unresolvedCases: [...unresolved, ...failedRules],
    canaryBlockers,
  }
}

function renderMarkdown(report: ComparisonReport, snapshotMeta: Record<string, unknown>): string {
  const counts = (record: Record<string, number>) =>
    Object.entries(record).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `- \`${key}\`: ${value}`).join('\n') || '- none'
  const differenceRows = report.differences.length
    ? [
        '| Lead | Status | Mode | Category | V1 intent | V2 action | Classification | Reason | Canary blocker |',
        '|---|---|---|---|---|---|---|---|---|',
        ...report.differences.map((item) =>
          `| \`${item.leadId}\` | ${item.status} | ${item.mode} | ${item.categoryPresent ? 'present' : 'null'} | ${item.v1Action} | ${item.v2Action} (${item.v2ReasonCode}) | ${item.classification} | ${item.reason} | ${item.canaryBlocker ? 'yes' : 'no'} |`),
      ].join('\n')
    : '_Every sampled lead matched. No differences to report._'
  const ruleRows = [
    '| # | Rule | Result | Evidence |',
    '|---|---|---|---|',
    ...report.rules.map((rule) => `| ${rule.id} | ${rule.rule} | ${rule.pass ? 'PASS' : 'FAIL'} | ${rule.detail} |`),
  ].join('\n')

  return `# ReachAgent V2 real shadow comparison

Date: ${report.date} (${report.timezone})

Status: **${report.status}**

Approach: one-time sanitized SELECT-only snapshot. A single read-only statement was
executed against the V1 target through the operator-run Supabase Management API
database-query path. The statement returned derived Decision Engine facts only. The
V1-vs-V2 comparison then ran entirely offline against that snapshot, which was
deleted afterwards. No V1 role, schema, view, policy, function, or key was created.

## Snapshot provenance

| Field | Value |
|---|---|
| Source | ${report.source} |
| Production SELECT executions | ${snapshotMeta.productionSelectExecutions ?? 'n/a'} |
| Target identity hash | \`${snapshotMeta.targetIdentityHash ?? 'n/a'}\` |
| Query hash (sha256) | \`${snapshotMeta.queryHash ?? 'n/a'}\` |
| Executed at | ${snapshotMeta.executedAt ?? 'n/a'} |
| Rows returned | ${report.sampleSize} |
| Snapshot file | \`.v2-local/prompt15-real-shadow-snapshot.json\` (git-ignored, deleted after comparison) |

## Sample coverage

- Sample size: ${report.sampleSize} (hard maximum 100)
- Canonical-status population: ${report.populationTotal ?? 'n/a'}
- Leads excluded for a non-canonical status: ${report.populationExcludedStatusTotal ?? 'n/a'}

### Sampled status distribution

${counts(report.statusDistribution)}

### Population status totals

${counts(report.populationStatusDistribution)}

### Initial-email mode distribution

${counts(report.modeDistribution)}

### Category disposition

${counts(report.categoryDistribution)}

### Cohort coverage in the sample

${counts(report.cohortCoverage)}

## Classification summary

- \`MATCH\`: ${report.classifications.MATCH}
- \`EXPECTED_V2_CONSOLIDATION\`: ${report.classifications.EXPECTED_V2_CONSOLIDATION}
- \`BUG_IN_OLD_LOGIC\`: ${report.classifications.BUG_IN_OLD_LOGIC}
- \`BUG_IN_NEW_ENGINE\`: ${report.classifications.BUG_IN_NEW_ENGINE}
- \`PRODUCT_DECISION_REQUIRED\`: ${report.classifications.PRODUCT_DECISION_REQUIRED}
- Canary blockers: ${report.canaryBlockers}

## Non-matching cases

${differenceRows}

## Rule verification

${ruleRows}

## Unresolved cases

${report.unresolvedCases.length ? report.unresolvedCases.map((item) => `- ${item}`).join('\n') : '- none'}

## Privacy

The snapshot carried only allow-listed derived facts. The automated scan in
\`scripts/prompt15-snapshot-safety.ts\` rejected every field outside the allowlist and
searched all string values for email addresses, URLs, and phone-like sequences. No
email address, business name, phone, address, raw city, website, subject, body,
template text, activity metadata, prompt, AI response, provider message ID, or
credential left V1. This report contains opaque lead IDs only.
`
}

function main(): void {
  const args = process.argv.slice(2)
  const snapshotPath = args.find((arg) => !arg.startsWith('--'))
  if (!snapshotPath) throw new Error('Usage: prompt15-offline-comparison.ts <snapshot.json> [--write-report] [--source <name>]')
  const sourceIndex = args.indexOf('--source')
  const source = sourceIndex >= 0 ? args[sourceIndex + 1] : 'unspecified'

  const parsed = JSON.parse(readFileSync(snapshotPath, 'utf8')) as { rows?: unknown; meta?: Record<string, unknown> } | unknown[]
  const rawRows = Array.isArray(parsed) ? parsed : parsed.rows
  const meta = Array.isArray(parsed) ? {} : (parsed.meta ?? {})
  validateSnapshotRows(rawRows)
  const rows = rawRows as unknown as SnapshotRow[]

  const cases = compareSnapshot(rows)
  const report = buildReport(rows, cases, source)

  if (args.includes('--write-report')) {
    writeFileSync('docs/reachagent-v2-real-shadow-comparison.json', `${JSON.stringify({ ...report, snapshot: meta }, null, 2)}\n`, 'utf8')
    writeFileSync('docs/reachagent-v2-real-shadow-comparison.md', renderMarkdown(report, meta), 'utf8')
  }

  // Console output is summary-only: never print snapshot rows.
  console.log(JSON.stringify({
    status: report.status,
    source,
    sampleSize: report.sampleSize,
    populationTotal: report.populationTotal,
    classifications: report.classifications,
    canaryBlockers: report.canaryBlockers,
    rulesPassed: report.rules.filter((rule) => rule.pass).length,
    rulesFailed: report.rules.filter((rule) => !rule.pass).length,
    unresolved: report.unresolvedCases.length,
    reportHash: createHash('sha256').update(JSON.stringify(report)).digest('hex').slice(0, 16),
  }, null, 2))

  if (report.status !== 'PROMPT 15 PASS') process.exitCode = 1
}

if (process.argv[1]?.endsWith('prompt15-offline-comparison.ts')) main()
