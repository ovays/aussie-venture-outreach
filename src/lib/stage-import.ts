// Single source of truth for "add a lead that already started outreach"
// (staged import via the Add Lead form). Used by both the frontend
// (AddLeadModal) and the create-lead API route.
//
// The production follow-up engine (src/lib/followup-eligibility.ts) always
// computes the next due follow-up from initial_pitch.sent_at plus the
// configured day offsets — it never looks at a separate "next due date"
// field. So the only way to make a staged import continue the existing
// sequence correctly is to backdate initial_pitch.sent_at (and every
// intermediate follow-up's sent_at) so the *relative* gaps between stages
// match the configured intervals, anchored on the user-supplied completion
// date for the stage they selected.

import type { FollowUpType } from '@/lib/followup-eligibility'

export const STAGE_VALUES = ['new', 'initial_sent', 'follow_up_1', 'follow_up_2', 'follow_up_3'] as const
export type LeadImportStage = typeof STAGE_VALUES[number]
export type CompletedImportStage = Exclude<LeadImportStage, 'new'>

export const STAGE_LABELS: Record<LeadImportStage, string> = {
  new:          'New (No Email Sent)',
  initial_sent: 'Initial Email Sent',
  follow_up_1:  'Follow-up 1 Sent',
  follow_up_2:  'Follow-up 2 Sent',
  follow_up_3:  'Follow-up 3 Sent',
}

export const STAGE_OPTIONS: Array<{ value: LeadImportStage; label: string }> =
  STAGE_VALUES.map((value) => ({ value, label: STAGE_LABELS[value] }))

// The `emails.type` value a completed stage corresponds to.
export const STAGE_EMAIL_TYPE: Record<CompletedImportStage, 'initial_pitch' | FollowUpType> = {
  initial_sent: 'initial_pitch',
  follow_up_1:  'follow_up_1',
  follow_up_2:  'follow_up_2',
  follow_up_3:  'follow_up_3',
}

// Every stage at-or-before a given stage, in order — 'new' has none.
const STAGE_PROGRESSION: Record<LeadImportStage, CompletedImportStage[]> = {
  new:          [],
  initial_sent: ['initial_sent'],
  follow_up_1:  ['initial_sent', 'follow_up_1'],
  follow_up_2:  ['initial_sent', 'follow_up_1', 'follow_up_2'],
  follow_up_3:  ['initial_sent', 'follow_up_1', 'follow_up_2', 'follow_up_3'],
}

export interface FollowUpDaySettings {
  fu1Days: number
  fu2Days: number
  fu3Days: number
}

// Cumulative day-offset from the initial pitch send date, per stage —
// identical to the thresholds computeFollowUpEligibility() checks against.
function stageOffsetDays(stage: CompletedImportStage, settings: FollowUpDaySettings): number {
  switch (stage) {
    case 'initial_sent': return 0
    case 'follow_up_1':  return settings.fu1Days
    case 'follow_up_2':  return settings.fu2Days
    case 'follow_up_3':  return settings.fu3Days
  }
}

export interface BackdatedStageEmail {
  stage: CompletedImportStage
  type: 'initial_pitch' | FollowUpType
  sentAt: Date
}

/**
 * Given the stage a manually-imported lead has already reached and the date
 * that stage was completed, returns the backdated sent_at for every stage up
 * to and including it. Inserting `emails` rows at these timestamps makes the
 * unmodified follow-up engine schedule the next stage exactly `existing
 * interval` days after `completedDate` — the same behaviour as if the lead
 * had been sent through this system from the start.
 */
export function computeBackdatedStageEmails(
  stage: LeadImportStage,
  completedDate: Date,
  settings: FollowUpDaySettings
): BackdatedStageEmail[] {
  if (stage === 'new') return []

  const targetOffset = stageOffsetDays(stage as CompletedImportStage, settings)

  return STAGE_PROGRESSION[stage].map((s) => {
    const deltaDays = targetOffset - stageOffsetDays(s, settings)
    return {
      stage: s,
      type: STAGE_EMAIL_TYPE[s],
      sentAt: new Date(completedDate.getTime() - deltaDays * 86_400_000),
    }
  })
}

export const FOLLOW_UP_NUMBER: Record<FollowUpType, 1 | 2 | 3> = {
  follow_up_1: 1,
  follow_up_2: 2,
  follow_up_3: 3,
}
