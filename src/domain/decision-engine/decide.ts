import type {
  DecisionAction,
  DecisionInputKey,
  DecisionMetadataValue,
  DecisionReasonCode,
  LeadDecisionContext,
  LeadDecisionResult,
} from './types'

const DAY_MS = 86_400_000

function result(
  context: LeadDecisionContext,
  action: DecisionAction,
  reasonCode: DecisionReasonCode,
  inputsUsed: readonly DecisionInputKey[],
  metadata?: Readonly<Record<string, DecisionMetadataValue>>,
): LeadDecisionResult {
  return { action, reasonCode, leadId: context.leadId, inputsUsed, ...(metadata ? { metadata } : {}) }
}

function elapsedDays(from: string, to: string): number | null {
  const fromMs = Date.parse(from)
  const toMs = Date.parse(to)
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return null
  return Math.floor((toMs - fromMs) / DAY_MS)
}

function decideReply(context: LeadDecisionContext): LeadDecisionResult | null {
  if (!context.reply.received && context.status !== 'replied') return null

  if (context.reply.classification === 'UNSUBSCRIBE') {
    return result(context, 'STOP', 'UNSUBSCRIBED', ['reply.received', 'reply.classification'])
  }
  if (context.reply.classification === 'OUT_OF_OFFICE') {
    return result(context, 'WAIT', 'OUT_OF_OFFICE', ['reply.received', 'reply.classification'])
  }
  if (context.reply.classification) {
    return result(context, 'HANDLE_REPLY', 'REPLY_RECEIVED', ['reply.received', 'reply.classification'], {
      classification: context.reply.classification,
    })
  }
  return result(context, 'HANDLE_REPLY', 'REPLY_CLASSIFICATION_REQUIRED', ['reply.received', 'status'])
}

function decideInitial(context: LeadDecisionContext): LeadDecisionResult {
  if (context.initialEmail.state === 'uncertain') {
    return result(context, 'MANUAL_REVIEW', 'INITIAL_SEND_UNCERTAIN', ['initialEmail.state'])
  }
  if (context.initialEmail.state === 'pending') {
    return result(context, 'SEND_INITIAL', 'INITIAL_CONTENT_READY', ['initialEmail.state', 'status'])
  }
  if (context.initialEmail.state === 'sent') {
    return result(context, 'MANUAL_REVIEW', 'STATUS_CONTENT_MISMATCH', ['initialEmail.state', 'status'])
  }

  if (context.status === 'email_ready') {
    return result(context, 'MANUAL_REVIEW', 'STATUS_CONTENT_MISMATCH', ['status', 'initialEmail.state'])
  }

  if (context.initialEmailMode === 'template') {
    if (!context.email) {
      if (context.status === 'new' && !context.research.contactDiscoveryComplete) {
        return result(context, 'RESEARCH', 'TEMPLATE_RESEARCH_REQUIRED', [
          'email', 'status', 'research.contactDiscoveryComplete', 'initialEmailMode',
        ])
      }
      return result(context, 'STOP', 'MISSING_EMAIL', ['email', 'status', 'research.contactDiscoveryComplete'])
    }
    if (!context.template.available) {
      return result(context, 'MANUAL_REVIEW', 'TEMPLATE_CONFIGURATION_INVALID', ['initialEmailMode', 'template.available'])
    }
    if (!context.template.requiredDataAvailable) {
      if (context.research.canSupplyTemplateFields) {
        return result(context, 'RESEARCH', 'TEMPLATE_RESEARCH_REQUIRED', [
          'template.requiredDataAvailable', 'research.canSupplyTemplateFields', 'initialEmailMode',
        ])
      }
      return result(context, 'MANUAL_REVIEW', 'TEMPLATE_DATA_UNAVAILABLE', [
        'template.requiredDataAvailable', 'research.canSupplyTemplateFields', 'initialEmailMode',
      ])
    }
    return result(context, 'GENERATE_INITIAL', 'TEMPLATE_READY', [
      'email', 'template.available', 'template.requiredDataAvailable', 'initialEmailMode', 'initialEmail.state',
    ], { generationMode: 'template' })
  }

  if (!context.research.personalisationComplete) {
    return result(context, 'RESEARCH', 'PERSONALIZED_RESEARCH_REQUIRED', [
      'initialEmailMode', 'research.personalisationComplete', 'status',
    ])
  }
  if (!context.email) {
    return result(context, 'STOP', 'MISSING_EMAIL', ['email', 'research.personalisationComplete', 'status'])
  }
  return result(context, 'GENERATE_INITIAL', 'INITIAL_CONTENT_REQUIRED', [
    'initialEmailMode', 'research.personalisationComplete', 'email', 'initialEmail.state',
  ], { generationMode: 'ai_personalised' })
}

function decideContacted(context: LeadDecisionContext): LeadDecisionResult {
  if (context.initialEmail.state !== 'sent' || !context.initialEmail.sentAt) {
    if (context.initialEmail.state === 'uncertain') {
      return result(context, 'MANUAL_REVIEW', 'INITIAL_SEND_UNCERTAIN', ['status', 'initialEmail.state'])
    }
    return result(context, 'MANUAL_REVIEW', 'INITIAL_SEND_MISSING', ['status', 'initialEmail.state', 'initialEmail.sentAt'])
  }

  const daysSinceInitial = elapsedDays(context.initialEmail.sentAt, context.asOf)
  if (daysSinceInitial === null) {
    return result(context, 'MANUAL_REVIEW', 'STATUS_CONTENT_MISMATCH', ['initialEmail.sentAt', 'asOf'])
  }

  const stages = [
    { key: 'followUp1', action: 'SEND_FOLLOWUP_1', reason: 'FOLLOWUP_1_READY', dueDays: context.schedule.followUp1Days },
    { key: 'followUp2', action: 'SEND_FOLLOWUP_2', reason: 'FOLLOWUP_2_READY', dueDays: context.schedule.followUp2Days },
    { key: 'followUp3', action: 'SEND_FOLLOWUP_3', reason: 'FOLLOWUP_3_READY', dueDays: context.schedule.followUp3Days },
  ] as const

  for (const stage of stages) {
    const emailStage = context.followUps[stage.key]
    if (emailStage.state === 'uncertain') {
      return result(context, 'MANUAL_REVIEW', 'FOLLOWUP_SEND_UNCERTAIN', [`followUps.${stage.key}`], { stage: stage.key })
    }
    if (emailStage.state !== 'sent') {
      if (daysSinceInitial < stage.dueDays) {
        return result(context, 'WAIT', 'FOLLOWUP_NOT_DUE', [
          'initialEmail.sentAt', 'asOf', `schedule.${stage.key === 'followUp1' ? 'followUp1Days' : stage.key === 'followUp2' ? 'followUp2Days' : 'followUp3Days'}`,
          `followUps.${stage.key}`,
        ], { stage: stage.key, dueDays: stage.dueDays, daysSinceInitial })
      }
      if (context.operationalFacts?.hasUsableCategoryContext !== true) {
        return result(context, 'MANUAL_REVIEW', 'CATEGORY_CONTEXT_REQUIRED', [
          'operationalFacts.hasUsableCategoryContext', 'initialEmail.sentAt', 'asOf', `followUps.${stage.key}`,
        ], { stage: stage.key, blockedAction: stage.action, dueDays: stage.dueDays, daysSinceInitial })
      }
      return result(context, stage.action, stage.reason, [
        'initialEmail.sentAt', 'asOf', `followUps.${stage.key}`,
      ], { stage: stage.key, dueDays: stage.dueDays, daysSinceInitial, contentReady: emailStage.state === 'pending' })
    }
  }

  if (context.reactivation.sentAt) {
    const daysSinceReactivation = elapsedDays(context.reactivation.sentAt, context.asOf)
    if (daysSinceReactivation === null) {
      return result(context, 'MANUAL_REVIEW', 'STATUS_CONTENT_MISMATCH', ['reactivation.sentAt', 'asOf'])
    }
    if (daysSinceReactivation >= context.schedule.deadAfterReactivationDays) {
      return result(context, 'MARK_DEAD', 'REACTIVATION_DEADLINE_REACHED', [
        'reactivation.sentAt', 'asOf', 'schedule.deadAfterReactivationDays',
      ], { daysSinceReactivation, targetStatus: 'dead' })
    }
    return result(context, 'WAIT', 'REACTIVATION_ALREADY_SENT', [
      'reactivation.sentAt', 'asOf', 'schedule.deadAfterReactivationDays',
    ], { daysSinceReactivation })
  }

  if (!context.reactivation.enabled) {
    const followUp3SentAt = context.followUps.followUp3.sentAt
    const daysSinceFollowUp3 = followUp3SentAt ? elapsedDays(followUp3SentAt, context.asOf) : null
    if (daysSinceFollowUp3 !== null && daysSinceFollowUp3 >= 1) {
      return result(context, 'MARK_DEAD', 'FOLLOWUP_SEQUENCE_COMPLETE', [
        'reactivation.enabled', 'followUps.followUp3', 'asOf',
      ], { daysSinceFollowUp3, targetStatus: 'dead' })
    }
    return result(context, 'WAIT', 'REACTIVATION_DISABLED', ['reactivation.enabled', 'followUps.followUp3', 'asOf'])
  }

  if (daysSinceInitial < context.schedule.reactivationDelayDays) {
    return result(context, 'WAIT', 'REACTIVATION_NOT_DUE', [
      'initialEmail.sentAt', 'asOf', 'schedule.reactivationDelayDays', 'reactivation.enabled',
    ], { daysSinceInitial, dueDays: context.schedule.reactivationDelayDays })
  }
  if (context.operationalFacts?.hasUsableCategoryContext !== true) {
    return result(context, 'MANUAL_REVIEW', 'CATEGORY_CONTEXT_REQUIRED', [
      'operationalFacts.hasUsableCategoryContext', 'initialEmail.sentAt', 'asOf',
      'schedule.reactivationDelayDays', 'reactivation.enabled', 'followUps.followUp3',
    ], { blockedAction: 'REACTIVATE', daysSinceInitial })
  }
  return result(context, 'REACTIVATE', 'REACTIVATION_READY', [
    'initialEmail.sentAt', 'asOf', 'schedule.reactivationDelayDays', 'reactivation.enabled', 'followUps.followUp3',
  ], { daysSinceInitial })
}

export function decideNextAction(context: LeadDecisionContext): LeadDecisionResult {
  if (context.duplicate || context.operationalFacts?.openDuplicateFlag) return result(context, 'STOP', 'DUPLICATE_LEAD', ['duplicate'])
  if (context.suppressed) return result(context, 'STOP', 'SUPPRESSED', ['suppressed'])

  if (context.status === 'closed' || context.status === 'closed_manual' || context.dealState === 'closed') {
    return result(context, 'STOP', 'TERMINAL_STATUS', ['status', 'dealState'])
  }

  const replyDecision = decideReply(context)
  if (replyDecision) return replyDecision

  if (context.status === 'dead') return result(context, 'STOP', 'TERMINAL_STATUS', ['status'])
  if (context.status === 'interested' || context.status === 'negotiating' || context.dealState === 'active') {
    return result(context, 'STOP', 'ACTIVE_DEAL_STATUS', ['status', 'dealState'])
  }

  if (context.manualOverride?.requestedStatus && context.manualOverride.requestedStatus !== context.status) {
    return result(context, 'MANUAL_REVIEW', 'MANUAL_OVERRIDE_REQUIRED', ['status', 'manualOverride.requestedStatus'], {
      requestedStatus: context.manualOverride.requestedStatus,
    })
  }

  if (context.operationalFacts?.manualSource && context.status !== 'contacted') {
    return result(context, 'MANUAL_REVIEW', 'MANUAL_SOURCE', ['status'])
  }
  if (context.operationalFacts?.recipientOwnership === 'owned_by_other') {
    return result(context, 'STOP', 'RECIPIENT_OWNED_BY_OTHER', ['email'])
  }

  if (context.status === 'contacted') return decideContacted(context)
  return decideInitial(context)
}
