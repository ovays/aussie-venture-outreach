import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

type Difference = {
  classification: string
  categoryPresent: boolean
  v1Action: string
  v2Action: string
  v2ReasonCode: string
  canaryBlocker: boolean
}

type DecisionReview = {
  summary: {
    totalProductDecisionCases: number
    sideEffectBlockers: number
  }
  decisions: Array<{
    decisionId: string
    affectedLeadCount: number
    sideEffectBlockerCount: number
  }>
}

const comparison = JSON.parse(readFileSync('docs/reachagent-v2-real-shadow-comparison.json', 'utf8')) as {
  classifications: Record<string, number>
  differences: Difference[]
}
const review = JSON.parse(readFileSync('docs/reachagent-v2-product-decision-review.json', 'utf8')) as DecisionReview

assert.equal(existsSync('.v2-local/prompt15-real-shadow-snapshot.json'), false)

const productDecisions = comparison.differences.filter((item) => item.classification === 'PRODUCT_DECISION_REQUIRED')
const pd01 = productDecisions.filter((item) =>
  !item.categoryPresent
  && item.v1Action === 'MANUAL_REVIEW'
  && item.v2ReasonCode.startsWith('FOLLOWUP_'))
const pd02 = productDecisions.filter((item) =>
  !item.categoryPresent
  && item.v1Action === 'MANUAL_REVIEW'
  && item.v2ReasonCode.startsWith('REACTIVATION_'))
const pd03 = productDecisions.filter((item) =>
  item.categoryPresent
  && item.v1Action === 'GENERATE_INITIAL'
  && item.v2Action === 'WAIT')

const grouped = new Set([...pd01, ...pd02, ...pd03])
assert.equal(productDecisions.length, 72)
assert.equal(grouped.size, productDecisions.length)
assert.deepEqual(
  [pd01.length, pd02.length, pd03.length],
  [30, 38, 4],
)
assert.deepEqual(
  [pd01.filter((item) => item.canaryBlocker).length, pd02.filter((item) => item.canaryBlocker).length, pd03.filter((item) => item.canaryBlocker).length],
  [19, 19, 0],
)

const projected = productDecisions.map((item) => {
  const blockedByApprovedGate = !item.categoryPresent && item.canaryBlocker
    && (item.v2Action.startsWith('SEND_FOLLOWUP_') || item.v2Action === 'REACTIVATE')
  return {
    ...item,
    projectedAction: blockedByApprovedGate ? 'MANUAL_REVIEW' : item.v2Action,
    projectedSideEffectBlocker: blockedByApprovedGate ? false : item.canaryBlocker,
  }
})

const convertedToManualReview = projected.filter((item) => item.canaryBlocker && item.projectedAction === 'MANUAL_REVIEW')
const remainingSideEffectBlockers = projected.filter((item) => item.projectedSideEffectBlocker)
const remainingDocumentationOnly = projected.filter((item) => !item.canaryBlocker)

assert.equal(convertedToManualReview.length, 38)
assert.equal(remainingSideEffectBlockers.length, 0)
assert.equal(remainingDocumentationOnly.length, 34)
assert.equal(comparison.classifications.BUG_IN_NEW_ENGINE, 0)
assert.equal(review.summary.totalProductDecisionCases, 72)
assert.equal(review.summary.sideEffectBlockers, 38)

for (const [decisionId, cases, blockers] of [
  ['PD-01', 30, 19],
  ['PD-02', 38, 19],
  ['PD-03', 4, 0],
] as const) {
  const decision = review.decisions.find((item) => item.decisionId === decisionId)
  assert.ok(decision)
  assert.equal(decision.affectedLeadCount, cases)
  assert.equal(decision.sideEffectBlockerCount, blockers)
}

console.log(JSON.stringify({
  status: 'PASS',
  source: 'retained-local-artifacts-only',
  productDecisionRequiredBefore: productDecisions.length,
  sideEffectBlockersBefore: 38,
  convertedToManualReview: convertedToManualReview.length,
  remainingProductDecisionRequired: remainingDocumentationOnly.length,
  sideEffectBlockersAfter: remainingSideEffectBlockers.length,
  bugInNewEngine: comparison.classifications.BUG_IN_NEW_ENGINE,
  productionAccess: 0,
  snapshotRecreated: false,
}, null, 2))
