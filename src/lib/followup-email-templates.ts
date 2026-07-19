// Single source of truth for follow-up email copy — used by the production
// follow-up sender (agents/followup.ts) and by staged-lead import backfill
// (src/app/api/leads/route.ts) so both produce byte-identical content for a
// given follow-up type.
//
// Follow-ups are plain templates (no Claude call) — the only per-lead
// variables are the business name, its generic category noun, and the
// visit/remote location word, all resolved from the same shared classifiers
// every other template uses.

import { textToHtml } from '@/lib/utils'
import { normalizeContentType, contentTypeLocationWord } from '@/lib/content-type'
import { getCategoryNoun, getCategoryReferenceNoun } from '@/lib/category-copy'
import type { FollowUpType } from '@/lib/followup-eligibility'

export function buildFollowUpEmail(
  type: FollowUpType,
  leadName: string,
  initialSubject: string,
  category: string,
  contentType: string
): { subject: string; body: string; html: string } {
  const normalized = normalizeContentType(contentType)
  const location = contentTypeLocationWord(normalized)
  const noun = getCategoryNoun(category)
  const refNoun = getCategoryReferenceNoun(category)

  if (type === 'follow_up_1') {
    const body = `Hey ${leadName}!

Still keen to feature your ${noun} on Aussie Venture — our ${location} audience genuinely loves discovering great local spots, and I think you'd be a wonderful fit.

Happy to keep things simple on your end. Let me know if you're open to it!

Cheers,
Owais
Aussie Venture
hello@aussieventure.com`

    return {
      subject: `Re: ${initialSubject}`,
      body,
      html: textToHtml(body),
    }
  }

  if (type === 'follow_up_2') {
    const body = `Hey ${leadName},

Timing can always be tricky — no worries if things have been busy on your end!

A feature on Aussie Venture is a simple way to connect your ${noun} with a genuinely engaged ${location} audience, and we keep it as easy as possible from your side.

If it sounds like something worth exploring, I'd love to hear your thoughts.

Cheers,
Owais
Aussie Venture
hello@aussieventure.com`

    return {
      subject: `Re: ${initialSubject}`,
      body,
      html: textToHtml(body),
    }
  }

  // follow_up_3
  const body = `Hey ${leadName},

No worries at all if the timing hasn't been right — these things don't always line up!

If a feature on Aussie Venture ever sounds like a good fit down the track, we'd genuinely love to hear from you at hello@aussieventure.com.

Wishing you and the team all the best — hope the ${refNoun} keeps going from strength to strength!

Cheers,
Owais
Aussie Venture`

  return {
    subject: `Re: ${initialSubject}`,
    body,
    html: textToHtml(body),
  }
}
