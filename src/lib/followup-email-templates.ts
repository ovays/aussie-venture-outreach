// Single source of truth for follow-up email copy — used as the fallback when
// Claude generation fails (src/lib/followup-generation.ts) and by staged-lead
// import backfill (src/app/api/leads/route.ts) so both produce byte-identical
// content for a given follow-up type.
//
// These are plain templates (no Claude call). The per-lead variables are the
// business name and the category reminder sentence, and nothing else. Every
// earlier version of this file interpolated a category noun and a location word
// into a sentence about our audience, which is exactly the re-pitching that
// suppresses replies. The reminder is different: it says who is typing, not why
// they should care, and it comes from getCategoryReminderFocus so it can never
// produce an awkward sentence for an unseen category.
//
// Each stage is a different beat, matching the prompt stages in claude.ts's
// buildFollowUpEmailPrompt:
//   FU1 (day 7)  — the first email may never have been seen; re-introduce, ask
//   FU2 (day 14) — one more check-in, made as cheap as possible to answer
//   FU3 (day 21) — closing the loop
//
// Every stage carries the reminder, because the reader receiving a follow-up is
// by definition the one who did not engage with email one. No stage mentions
// packages, pricing, budgets or an offer to send anything through: once the first
// email has gone out, the only question worth asking is whether they're
// interested, and a second question halves the odds of either being answered.
// Test:email-voice enforces both rules across all three stages so a future edit
// can't quietly turn a follow-up back into a pitch.

import { textToHtml } from '@/lib/utils'
import { FOLLOW_UP_SIGN_OFF, reminderFor, fu3ClosingFor } from '@/lib/email-voice'
import type { FollowUpType } from '@/lib/followup-eligibility'

const BODIES: Record<FollowUpType, (leadName: string, reminder: string) => string> = {
  // No packages, no pricing, no offer to send anything through. FU1 used to end
  // "Happy to send our package options over if you want a look." — see
  // NO_COMMERCIALS_RULE in email-voice.ts for why that line cost more replies
  // than it earned. Every stage now asks one question and stops.
  follow_up_1: (leadName, reminder) => `Hey ${leadName},

I emailed you last week but it may not have reached you.

${reminder}

I was asking whether you'd want to do a collab with us.

Would you be interested?

${FOLLOW_UP_SIGN_OFF}`,

  // FU2's job is to make the reply cheaper than the decision. Mentioning the
  // silence here would collide with FU3's opening line, so this one is framed as
  // "in case it was missed" instead.
  follow_up_2: (leadName, reminder) => `Hey ${leadName},

Checking once more in case my earlier emails got buried.

${reminder}

Is a collab something you'd be interested in? A yes or no is all I need.

${FOLLOW_UP_SIGN_OFF}`,

  // The opening line comes from FU3_CLOSING_LINES so the fallback closes a thread
  // in the same first-person, active wording the generated version does.
  follow_up_3: (leadName, reminder) => `Hey ${leadName},

${fu3ClosingFor(leadName)}

${reminder}

If a collab is something you'd want to look at later, reply any time and I'll pick it back up.

${FOLLOW_UP_SIGN_OFF}`,
}

// Salt matches buildFollowUpEmailPrompt's, so a lead that falls back to the
// template mid-thread gets the same reminder wording it would have got from the
// model rather than a visibly different sentence.
const REMINDER_SALT: Record<FollowUpType, string> = {
  follow_up_1: 'fu1',
  follow_up_2: 'fu2',
  follow_up_3: 'fu3',
}

export function buildFollowUpEmail(
  type: FollowUpType,
  leadName: string,
  initialSubject: string,
  category: string,
  _contentType: string
): { subject: string; body: string; html: string } {
  const body = BODIES[type](leadName, reminderFor(category, leadName, REMINDER_SALT[type]))

  return {
    subject: `Re: ${initialSubject}`,
    body,
    html: textToHtml(body),
  }
}
