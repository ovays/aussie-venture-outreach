import { sanitizeErrorMessage } from '@/lib/observability/sanitize'
import { evaluateLeadShadow, type EvaluateLeadShadowDependencies } from './evaluator'
import type { ShadowComparisonSummary, ShadowEvaluationOutcome } from './types'
import type { ShadowDifferenceClassification } from '@/domain/decision-engine'

export const MAX_SHADOW_BATCH_SIZE = 100
export const DEFAULT_SHADOW_CONCURRENCY = 4

const CLASSIFICATIONS: readonly ShadowDifferenceClassification[] = [
  'MATCH', 'EXPECTED_V2_CONSOLIDATION', 'BUG_IN_OLD_LOGIC', 'BUG_IN_NEW_ENGINE', 'PRODUCT_DECISION_REQUIRED',
]

export function summarizeShadowResults(outcomes: readonly ShadowEvaluationOutcome[]): ShadowComparisonSummary {
  const classifications = Object.fromEntries(CLASSIFICATIONS.map((name) => [name, 0])) as Record<ShadowDifferenceClassification, number>
  const actionDistribution: Record<string, number> = {}
  const reasonDistribution: Record<string, number> = {}
  const statusDistribution: Record<string, number> = {}
  let failedEvaluationCount = 0
  for (const outcome of outcomes) {
    if (!outcome.ok) { failedEvaluationCount++; continue }
    const item = outcome.result
    classifications[item.classification]++
    actionDistribution[item.v2Action] = (actionDistribution[item.v2Action] ?? 0) + 1
    reasonDistribution[item.reason.v2ReasonCode] = (reasonDistribution[item.reason.v2ReasonCode] ?? 0) + 1
    statusDistribution[item.relevantFacts.status] = (statusDistribution[item.relevantFacts.status] ?? 0) + 1
  }
  return { totalEvaluated: outcomes.length - failedEvaluationCount, failedEvaluationCount, classifications, actionDistribution, reasonDistribution, statusDistribution }
}

export async function evaluateShadowBatch(
  leadIds: readonly string[],
  dependencies: EvaluateLeadShadowDependencies,
  concurrency = DEFAULT_SHADOW_CONCURRENCY,
): Promise<{ outcomes: ShadowEvaluationOutcome[]; summary: ShadowComparisonSummary }> {
  const ids = [...new Set(leadIds)]
  if (ids.length === 0) throw new Error('Shadow batch requires at least one explicit lead.')
  if (ids.length > MAX_SHADOW_BATCH_SIZE) throw new Error(`Shadow batch exceeds ${MAX_SHADOW_BATCH_SIZE} leads.`)
  const width = Math.max(1, Math.min(Math.floor(concurrency), 10, ids.length))
  const outcomes = new Array<ShadowEvaluationOutcome>(ids.length)
  let cursor = 0
  await Promise.all(Array.from({ length: width }, async () => {
    while (true) {
      const index = cursor++
      if (index >= ids.length) return
      try {
        outcomes[index] = { ok: true, result: await evaluateLeadShadow(ids[index], dependencies) }
      } catch (error) {
        outcomes[index] = { ok: false, leadId: ids[index], error: sanitizeErrorMessage(error) }
      }
    }
  }))
  return { outcomes, summary: summarizeShadowResults(outcomes) }
}
