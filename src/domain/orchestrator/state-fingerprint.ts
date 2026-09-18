import type { LeadDecisionContext } from '@/domain/decision-engine'

// Only fields capable of changing the next decision are included. Volatile row
// metadata and unrelated lead columns deliberately do not participate.
export function decisionStateFingerprint(context: LeadDecisionContext): string {
  return JSON.stringify({
    status: context.status,
    email: context.email,
    duplicate: context.duplicate,
    suppressed: context.suppressed,
    dealState: context.dealState,
    initialEmailMode: context.initialEmailMode,
    research: context.research,
    template: context.template,
    initialEmail: context.initialEmail,
    followUps: context.followUps,
    reply: context.reply,
    reactivation: context.reactivation,
    manualOverride: context.manualOverride,
  })
}
