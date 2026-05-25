/**
 * Shared follow-up eligibility logic — single source of truth for both the
 * follow-up agent (agents/followup.ts) and the lifecycle dashboard API
 * (/api/lifecycle and /lib/analytics).
 *
 * All daysSince calculations use raw UTC arithmetic:
 *   Math.floor((now.getTime() - new Date(sentAt).getTime()) / 86_400_000)
 *
 * Supabase TIMESTAMPTZ values are always UTC, and Date.now() / new Date()
 * are also UTC, so no timezone conversion is needed for elapsed-days math.
 * The same formula in every caller is the guarantee of consistency.
 *
 * "Sent" is determined by sent_at presence only — not email.status.
 * A dispatched email remains "sent" even if a bounce is recorded later
 * (status='bounced', sent_at still set), which prevents re-sending to
 * known-bad addresses.
 */

export type FollowUpType = 'follow_up_1' | 'follow_up_2' | 'follow_up_3'

export interface FollowUpSettings {
  fu1Days: number
  fu2Days: number
  fu3Days: number  // = dead_lead_days — threshold for the third follow-up
}

export interface FollowUpEligibilityResult {
  nextFuType: FollowUpType | null  // which follow-up to send next; null when all sent
  isDue: boolean                    // true when daysSince >= dueAtDays
  daysSince: number                 // whole calendar days since initial pitch (UTC)
  dueAtDays: number | null          // day threshold for the next FU; null when all sent
  daysUntilDue: number | null       // 0 when already due; positive while waiting; null when all sent
}

export function computeFollowUpEligibility(
  initialEmailSentAt: string,
  hasFu1Sent: boolean,
  hasFu2Sent: boolean,
  hasFu3Sent: boolean,
  settings: FollowUpSettings,
  now = new Date()
): FollowUpEligibilityResult {
  const daysSince = Math.floor((now.getTime() - new Date(initialEmailSentAt).getTime()) / 86_400_000)

  let nextFuType: FollowUpType | null
  let dueAtDays: number | null

  if (!hasFu1Sent) {
    nextFuType = 'follow_up_1'
    dueAtDays = settings.fu1Days
  } else if (!hasFu2Sent) {
    nextFuType = 'follow_up_2'
    dueAtDays = settings.fu2Days
  } else if (!hasFu3Sent) {
    nextFuType = 'follow_up_3'
    dueAtDays = settings.fu3Days
  } else {
    nextFuType = null
    dueAtDays = null
  }

  const isDue = nextFuType !== null && dueAtDays !== null && daysSince >= dueAtDays
  const daysUntilDue = dueAtDays !== null ? Math.max(0, dueAtDays - daysSince) : null

  return { nextFuType, isDue, daysSince, dueAtDays, daysUntilDue }
}

/**
 * Whether an email row counts as "sent" for follow-up eligibility purposes.
 * Checks sent_at only — not email.status — so bounced emails (which have
 * sent_at set) are correctly treated as delivered.
 */
export function isFuEmailSent(email: { sent_at: string | null }): boolean {
  return email.sent_at !== null
}
