import type { ShadowDifferenceClassification } from '@/domain/decision-engine'

export interface ExpectedDifferenceRegistration {
  id: string
  legacyBehavior: string
  v2Behavior: string
  classification: ShadowDifferenceClassification
  approved: boolean
  why: string
  testReference: string
}

export const EXPECTED_DIFFERENCE_REGISTER: readonly ExpectedDifferenceRegistration[] = [
  {
    id: 'SD-001',
    legacyBehavior: 'A template-ready new lead routes through Researcher before Writer.',
    v2Behavior: 'Decision Engine returns GENERATE_INITIAL and deterministic template rendering uses no Research AI.',
    classification: 'EXPECTED_V2_CONSOLIDATION',
    approved: true,
    why: 'Prompt 9 intentionally removes unnecessary research when all template and recipient facts already exist.',
    testReference: 'scripts/test-v2-shadow-readiness.ts: template-ready-new',
  },
  {
    id: 'SD-002',
    legacyBehavior: 'Lifecycle UI may project a named future action before its due date.',
    v2Behavior: 'Executable Decision Engine returns WAIT until the action is due.',
    classification: 'EXPECTED_V2_CONSOLIDATION',
    approved: true,
    why: 'Display projection and executable intent have different semantics; only due executable action may run.',
    testReference: 'scripts/test-v2-decision-engine.ts: lifecycle projection comparison',
  },
  {
    id: 'SD-003',
    legacyBehavior: 'Batch agents repeat routing and eligibility checks inside each operational stage.',
    v2Behavior: 'Decision Engine centralizes routing; exact-lead services retain send-time safety rechecks.',
    classification: 'EXPECTED_V2_CONSOLIDATION',
    approved: true,
    why: 'Prompts 11 and 12 approved consolidation without removing final state/idempotency checks.',
    testReference: 'scripts/test-v2-agent-consolidation.ts',
  },
] as const

export const SHADOW_CLASSIFICATION_ALIASES = {
  BUG_IN_ORCHESTRATOR: 'BUG_IN_NEW_ENGINE',
} as const
