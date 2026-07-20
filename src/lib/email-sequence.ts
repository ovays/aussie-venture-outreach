// Single source of truth for "what email comes next for this lead" — given
// every emails row already recorded for a lead, decides whether the next
// send is the initial pitch, which follow-up stage (1/2/3) is next, or
// whether the full sequence is already complete. Shared by the automated
// follow-up cron (agents/followup.ts) and the manual "Send Email" action
// (src/app/api/leads/[id]/resend/route.ts) so both pick the same next email
// and thread it identically — a lead whose initial_pitch (or an earlier
// follow-up) was already delivered must never be sent another initial pitch.

import { isFuEmailSent, type FollowUpType } from './followup-eligibility'

export interface LeadEmailForThread {
  type: string
  subject: string
  body_text: string | null
  sent_at: string | null
  status: string
  message_id: string | null
}

const THREAD_TYPES = ['initial_pitch', 'follow_up_1', 'follow_up_2', 'follow_up_3']

// Builds the AI prompt's thread history from every email already sent for a
// lead (initial pitch + any earlier follow-ups), oldest first.
export function buildEmailHistory(emails: LeadEmailForThread[]) {
  return emails
    .filter((e) => THREAD_TYPES.includes(e.type) && isFuEmailSent(e))
    .sort((a, b) => new Date(a.sent_at!).getTime() - new Date(b.sent_at!).getTime())
    .map((e) => ({ type: e.type, subject: e.subject, body: e.body_text ?? '' }))
}

// Builds the RFC threading References chain (oldest first) from every prior
// sent email in this lead's thread — degrades gracefully for rows sent
// before the message_id column existed (they're simply omitted).
export function buildReferenceChain(emails: LeadEmailForThread[]): string[] {
  return emails
    .filter((e) => THREAD_TYPES.includes(e.type) && isFuEmailSent(e) && e.message_id)
    .sort((a, b) => new Date(a.sent_at!).getTime() - new Date(b.sent_at!).getTime())
    .map((e) => e.message_id!)
}

export type NextEmailDecision =
  | { kind: 'initial' }
  | { kind: 'follow_up'; type: FollowUpType; initialEmail: LeadEmailForThread }
  | { kind: 'all_sent' }

// "Sent" is judged the same way everywhere in this codebase: sent_at
// presence (isFuEmailSent), never emails.status — see followup-eligibility.ts.
export function determineNextEmailType(emails: LeadEmailForThread[]): NextEmailDecision {
  const initialEmail = emails.find((e) => e.type === 'initial_pitch' && isFuEmailSent(e)) ?? null
  if (!initialEmail) return { kind: 'initial' }

  const hasFu1Sent = emails.some((e) => e.type === 'follow_up_1' && isFuEmailSent(e))
  const hasFu2Sent = emails.some((e) => e.type === 'follow_up_2' && isFuEmailSent(e))
  const hasFu3Sent = emails.some((e) => e.type === 'follow_up_3' && isFuEmailSent(e))

  if (!hasFu1Sent) return { kind: 'follow_up', type: 'follow_up_1', initialEmail }
  if (!hasFu2Sent) return { kind: 'follow_up', type: 'follow_up_2', initialEmail }
  if (!hasFu3Sent) return { kind: 'follow_up', type: 'follow_up_3', initialEmail }
  return { kind: 'all_sent' }
}
