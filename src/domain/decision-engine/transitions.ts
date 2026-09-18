import { ALL_STATUSES, type LeadStatus } from '@/lib/lead-status'

export type TransitionActor = 'automated' | 'manual'

export interface LifecycleTransition {
  from: LeadStatus
  to: LeadStatus
  actors: readonly TransitionActor[]
  reason: string
}

// Terminal for automated outbound work. `dead -> replied` remains the single
// deterministic recovery edge for a genuinely late inbound reply.
export const TERMINAL_LEAD_STATUSES = ['closed', 'closed_manual', 'dead'] as const satisfies readonly LeadStatus[]

export const LIFECYCLE_TRANSITIONS: readonly LifecycleTransition[] = [
  { from: 'new', to: 'researched', actors: ['automated', 'manual'], reason: 'Research completed or a lead was manually qualified.' },
  { from: 'new', to: 'dead', actors: ['automated', 'manual'], reason: 'No viable outreach channel remains.' },
  { from: 'new', to: 'closed', actors: ['automated', 'manual'], reason: 'A deal was recorded.' },
  { from: 'new', to: 'closed_manual', actors: ['manual'], reason: 'Operator closed the lead.' },
  { from: 'researched', to: 'email_ready', actors: ['automated', 'manual'], reason: 'Initial content was materialized.' },
  { from: 'researched', to: 'dead', actors: ['automated', 'manual'], reason: 'Research completed without an eligible address.' },
  { from: 'researched', to: 'closed', actors: ['automated', 'manual'], reason: 'A deal was recorded.' },
  { from: 'researched', to: 'closed_manual', actors: ['manual'], reason: 'Operator closed the lead.' },
  { from: 'email_ready', to: 'researched', actors: ['automated', 'manual'], reason: 'Stale or invalid draft was removed for repair.' },
  { from: 'email_ready', to: 'contacted', actors: ['automated', 'manual'], reason: 'Initial outreach was delivered or explicitly marked sent.' },
  { from: 'email_ready', to: 'closed', actors: ['automated', 'manual'], reason: 'A deal was recorded.' },
  { from: 'email_ready', to: 'closed_manual', actors: ['manual'], reason: 'Operator closed the lead.' },
  { from: 'contacted', to: 'replied', actors: ['automated', 'manual'], reason: 'An inbound reply was received.' },
  { from: 'contacted', to: 'interested', actors: ['manual'], reason: 'Operator classified a positive reply.' },
  { from: 'contacted', to: 'negotiating', actors: ['manual'], reason: 'Operator advanced the opportunity.' },
  { from: 'contacted', to: 'dead', actors: ['automated', 'manual'], reason: 'The no-response lifecycle completed.' },
  { from: 'contacted', to: 'closed', actors: ['automated', 'manual'], reason: 'A deal was recorded.' },
  { from: 'contacted', to: 'closed_manual', actors: ['manual'], reason: 'Operator closed the lead.' },
  { from: 'replied', to: 'interested', actors: ['manual'], reason: 'Operator classified a positive reply.' },
  { from: 'replied', to: 'negotiating', actors: ['manual'], reason: 'Operator advanced the opportunity.' },
  { from: 'replied', to: 'dead', actors: ['manual'], reason: 'Operator classified the conversation as ended.' },
  { from: 'replied', to: 'closed', actors: ['automated', 'manual'], reason: 'A deal was recorded.' },
  { from: 'replied', to: 'closed_manual', actors: ['manual'], reason: 'Operator closed the lead.' },
  { from: 'interested', to: 'negotiating', actors: ['manual'], reason: 'Operator advanced the opportunity.' },
  { from: 'interested', to: 'replied', actors: ['manual'], reason: 'Operator moved the lead back to reply review.' },
  { from: 'interested', to: 'dead', actors: ['manual'], reason: 'Operator ended the opportunity.' },
  { from: 'interested', to: 'closed', actors: ['automated', 'manual'], reason: 'A deal was recorded.' },
  { from: 'interested', to: 'closed_manual', actors: ['manual'], reason: 'Operator closed the lead.' },
  { from: 'negotiating', to: 'interested', actors: ['manual'], reason: 'Operator moved the opportunity back one stage.' },
  { from: 'negotiating', to: 'replied', actors: ['manual'], reason: 'Operator moved the lead back to reply review.' },
  { from: 'negotiating', to: 'dead', actors: ['manual'], reason: 'Operator ended the opportunity.' },
  { from: 'negotiating', to: 'closed', actors: ['automated', 'manual'], reason: 'A deal was recorded.' },
  { from: 'negotiating', to: 'closed_manual', actors: ['manual'], reason: 'Operator closed the lead.' },
  { from: 'dead', to: 'replied', actors: ['automated', 'manual'], reason: 'A late inbound reply revived reply handling.' },
  { from: 'dead', to: 'closed', actors: ['automated', 'manual'], reason: 'A deal was recorded after outreach ended.' },
  { from: 'dead', to: 'closed_manual', actors: ['manual'], reason: 'Operator explicitly closed the lead.' },
] as const

const transitionKey = (from: LeadStatus, to: LeadStatus) => `${from}:${to}`
const TRANSITION_BY_KEY = new Map(LIFECYCLE_TRANSITIONS.map((transition) => [transitionKey(transition.from, transition.to), transition]))

export function getLifecycleTransition(from: LeadStatus, to: LeadStatus): LifecycleTransition | null {
  if (from === to) return { from, to, actors: ['automated', 'manual'], reason: 'Idempotent no-op.' }
  return TRANSITION_BY_KEY.get(transitionKey(from, to)) ?? null
}

export function isLifecycleTransitionAllowed(from: LeadStatus, to: LeadStatus, actor: TransitionActor): boolean {
  return getLifecycleTransition(from, to)?.actors.includes(actor) ?? false
}

export function isCanonicalLeadStatus(value: string): value is LeadStatus {
  return (ALL_STATUSES as readonly string[]).includes(value)
}
