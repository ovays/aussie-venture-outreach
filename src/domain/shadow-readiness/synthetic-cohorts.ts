import { DEFAULT_DECISION_SCHEDULE, type LeadDecisionContext } from '@/domain/decision-engine'

const AS_OF = '2026-09-15T00:00:00.000Z'
const missing = { state: 'missing' as const, sentAt: null }
const sent = (sentAt: string) => ({ state: 'sent' as const, sentAt })

function base(id: string): LeadDecisionContext {
  return {
    leadId: id, status: 'new', email: `${id}@example.test`, duplicate: false, suppressed: false,
    dealState: 'none', initialEmailMode: 'ai_personalised',
    research: { contactDiscoveryComplete: false, personalisationComplete: false, canSupplyTemplateFields: false },
    template: { available: false, requiredDataAvailable: false }, initialEmail: missing,
    followUps: { followUp1: missing, followUp2: missing, followUp3: missing },
    reply: { received: false, classification: null }, reactivation: { enabled: true, sentAt: null },
    schedule: { ...DEFAULT_DECISION_SCHEDULE }, asOf: AS_OF, manualOverride: null,
    operationalFacts: { categoryIdPresent: true, hasUsableCategoryContext: true, manualSource: false, recipientOwnership: 'unclaimed', openDuplicateFlag: false },
  }
}

function contacted(id: string, initialAt = '2026-09-10T00:00:00.000Z'): LeadDecisionContext {
  return { ...base(id), status: 'contacted', research: { contactDiscoveryComplete: true, personalisationComplete: true, canSupplyTemplateFields: false }, initialEmail: sent(initialAt) }
}

export interface SyntheticShadowCohort { name: string; group: string; context: LeadDecisionContext }

export const SYNTHETIC_SHADOW_COHORTS: readonly SyntheticShadowCohort[] = [
  { name: 'template-ready-new', group: 'NEW', context: { ...base('template-ready-new'), initialEmailMode: 'template', template: { available: true, requiredDataAvailable: true } } },
  { name: 'template-missing-data', group: 'NEW', context: { ...base('template-missing-data'), initialEmailMode: 'template', template: { available: true, requiredDataAvailable: false }, research: { contactDiscoveryComplete: true, personalisationComplete: false, canSupplyTemplateFields: true } } },
  { name: 'personalized-missing-research', group: 'NEW', context: base('personalized-missing-research') },
  { name: 'personalized-researched', group: 'NEW', context: { ...base('personalized-researched'), status: 'researched', research: { contactDiscoveryComplete: true, personalisationComplete: true, canSupplyTemplateFields: false } } },
  { name: 'initial-pending', group: 'EMAIL_READY', context: { ...base('initial-pending'), status: 'email_ready', initialEmail: { state: 'pending', sentAt: null } } },
  { name: 'uncertain-send', group: 'EMAIL_READY', context: { ...base('uncertain-send'), status: 'email_ready', initialEmail: { state: 'uncertain', sentAt: null } } },
  { name: 'suppressed', group: 'EMAIL_READY', context: { ...base('suppressed'), status: 'email_ready', suppressed: true, initialEmail: { state: 'pending', sentAt: null } } },
  { name: 'fu-not-due', group: 'CONTACTED', context: contacted('fu-not-due') },
  { name: 'fu1-due', group: 'CONTACTED', context: contacted('fu1-due', '2026-09-01T00:00:00.000Z') },
  { name: 'fu2-due', group: 'CONTACTED', context: { ...contacted('fu2-due', '2026-08-31T00:00:00.000Z'), followUps: { followUp1: sent('2026-09-07T00:00:00.000Z'), followUp2: missing, followUp3: missing } } },
  { name: 'fu3-due', group: 'CONTACTED', context: { ...contacted('fu3-due', '2026-08-20T00:00:00.000Z'), followUps: { followUp1: sent('2026-08-27T00:00:00.000Z'), followUp2: sent('2026-09-03T00:00:00.000Z'), followUp3: missing } } },
  { name: 'all-fus-complete', group: 'CONTACTED', context: { ...contacted('all-fus-complete', '2026-08-20T00:00:00.000Z'), reactivation: { enabled: false, sentAt: null }, followUps: { followUp1: sent('2026-08-27T00:00:00.000Z'), followUp2: sent('2026-09-03T00:00:00.000Z'), followUp3: sent(AS_OF) } } },
  { name: 'reactivation-not-due', group: 'CONTACTED', context: { ...contacted('reactivation-not-due', '2026-08-20T00:00:00.000Z'), followUps: { followUp1: sent('2026-08-27T00:00:00.000Z'), followUp2: sent('2026-09-03T00:00:00.000Z'), followUp3: sent('2026-09-10T00:00:00.000Z') } } },
  { name: 'reactivation-due', group: 'CONTACTED', context: { ...contacted('reactivation-due', '2026-06-01T00:00:00.000Z'), followUps: { followUp1: sent('2026-06-08T00:00:00.000Z'), followUp2: sent('2026-06-15T00:00:00.000Z'), followUp3: sent('2026-06-22T00:00:00.000Z') } } },
  { name: 'reply-interested', group: 'REPLIES', context: { ...contacted('reply-interested'), status: 'replied', reply: { received: true, classification: 'INTERESTED' } } },
  { name: 'reply-unsubscribe', group: 'REPLIES', context: { ...contacted('reply-unsubscribe'), status: 'replied', reply: { received: true, classification: 'UNSUBSCRIBE' } } },
  { name: 'reply-ooo', group: 'REPLIES', context: { ...contacted('reply-ooo'), status: 'replied', reply: { received: true, classification: 'OUT_OF_OFFICE' } } },
  { name: 'reply-unclear', group: 'REPLIES', context: { ...contacted('reply-unclear'), status: 'replied', reply: { received: true, classification: 'UNCLEAR' } } },
  ...(['dead', 'closed', 'closed_manual', 'interested', 'negotiating'] as const).map((status) => ({ name: `terminal-${status}`, group: 'TERMINAL', context: { ...contacted(`terminal-${status}`), status } })),
  { name: 'duplicate', group: 'DATA_QUALITY', context: { ...base('duplicate'), duplicate: true } },
  { name: 'missing-email', group: 'DATA_QUALITY', context: { ...base('missing-email'), status: 'researched', email: null, research: { contactDiscoveryComplete: true, personalisationComplete: true, canSupplyTemplateFields: false } } },
  { name: 'invalid-template', group: 'DATA_QUALITY', context: { ...base('invalid-template'), status: 'researched', initialEmailMode: 'template', template: { available: false, requiredDataAvailable: false } } },
  { name: 'manual-override', group: 'DATA_QUALITY', context: { ...base('manual-override'), manualOverride: { requestedStatus: 'dead' } } },
  { name: 'manual-source', group: 'DATA_QUALITY', context: { ...base('manual-source'), operationalFacts: { categoryIdPresent: true, hasUsableCategoryContext: true, manualSource: true, recipientOwnership: 'unclaimed', openDuplicateFlag: false } } },
  { name: 'missing-category', group: 'DATA_QUALITY', context: { ...base('missing-category'), status: 'researched', initialEmailMode: 'template', operationalFacts: { categoryIdPresent: false, hasUsableCategoryContext: false, manualSource: false, recipientOwnership: 'unclaimed', openDuplicateFlag: false } } },
] as const
