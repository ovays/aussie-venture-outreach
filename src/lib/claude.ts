import Anthropic, { APIError } from '@anthropic-ai/sdk'
import { withRetry } from './retry'
import { normalizeContentType, contentTypeBrandPrefix, type ContentType } from './content-type'
import { getContentFocus, getReactivationFocus, getCategoryReferenceNoun } from './category-copy'
import {
  VOICE_RULES,
  BANNED_WORDING,
  NO_SELLING_RULE,
  NO_COMMERCIALS_RULE,
  LENGTH_RULE,
  PLAIN_DETAIL_RULE,
  brandIntroOptions,
  INITIAL_SIGN_OFF,
  FOLLOW_UP_SIGN_OFF,
  signOffRule,
  enforceSignOff,
  pickVariant,
  REASON_SHAPES,
  REASON_CONNECTORS,
  INITIAL_ASKS,
  outreachSubjectFor,
  reminderFor,
  fu3ClosingFor,
  REACTIVATION_ASKS,
  reactivationContextFor,
  reactivationSubjectFor,
} from './email-voice'

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY!,
})

const HAIKU_MODEL = 'claude-haiku-4-5-20251001'
const SONNET_MODEL = 'claude-sonnet-4-6'

let claudeCallCount = 0
let claudeCallWindowStart = Date.now()
const CLAUDE_RATE_LIMIT = 20

function is529Overload(err: unknown): boolean {
  if (err instanceof APIError) return err.status === 529
  const msg = err instanceof Error ? err.message : String(err)
  return msg.includes('529') || msg.toLowerCase().includes('overloaded')
}

async function rateLimitedCall<T>(fn: () => Promise<T>): Promise<T> {
  const now = Date.now()
  if (now - claudeCallWindowStart > 60_000) {
    claudeCallCount = 0
    claudeCallWindowStart = now
  }
  if (claudeCallCount >= CLAUDE_RATE_LIMIT) {
    const wait = 60_000 - (now - claudeCallWindowStart)
    await new Promise((r) => setTimeout(r, wait))
    claudeCallCount = 0
    claudeCallWindowStart = Date.now()
  }
  claudeCallCount++
  // 3 retries (4 total attempts) for 529 overload: delays ~1s, 2s, 4s
  return withRetry(fn, { maxAttempts: 4, baseDelayMs: 1000, isRetryable: is529Overload })
}

// Aussie Venture is always described as one consistent lifestyle brand — never
// redefined per category (no "activities and entertainment platform" for one
// business and "food, travel and lifestyle platform" for another).
export function getBrandDescription(_category: string, contentType: ContentType): string {
  const prefix = contentTypeBrandPrefix(contentType)
  const article = prefix === 'Sydney-based' ? 'a' : 'an'
  return `${article} ${prefix} lifestyle platform`
}

function getCategoryPitch(category: string, contentType: ContentType): string {
  const focus = getContentFocus(category, contentType)
  const noun = getCategoryReferenceNoun(category)
  return `Owais creates ${focus} for 650K+ Australians and wants to collab with this ${noun}.`
}

export async function extractWebsiteData(websiteContent: string): Promise<{
  description: string
  services: string
  instagram_handle: string | null
  facebook_url: string | null
  other_social: string | null
}> {
  const response = await rateLimitedCall(() =>
    anthropic.messages.create({
      model: HAIKU_MODEL,
      max_tokens: 512,
      messages: [
        {
          role: 'user',
          content: `Extract the following from this business website content:
- Brief description (1-2 sentences)
- Main services offered
- Instagram handle (if mentioned, just the handle like @businessname)
- Facebook URL (if mentioned)
- Any other social media

Website content: ${websiteContent.slice(0, 4000)}

Respond in JSON only with keys: description, services, instagram_handle, facebook_url, other_social`,
        },
      ],
    })
  )

  const text = response.content[0].type === 'text' ? response.content[0].text : ''
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0])
      return {
        // Claude sometimes returns "services" as a list even though the prompt
        // asks for prose — coerce here since this is stored in a TEXT column
        // and interpolated directly into prompt strings by every caller.
        description: coerceToText(parsed.description),
        services: coerceToText(parsed.services),
        instagram_handle: parsed.instagram_handle || null,
        facebook_url: parsed.facebook_url || null,
        other_social: parsed.other_social || null,
      }
    }
  } catch {
    // fallback
  }
  return {
    description: '',
    services: '',
    instagram_handle: null,
    facebook_url: null,
    other_social: null,
  }
}

function coerceToText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.join(', ')
  return ''
}

// Pure prompt builder — exported so preview/test scripts can generate the exact
// same prompt Claude receives in production without duplicating the copy.
//
// Email 1 of the sequence. Its only job is to START A CONVERSATION: say who you
// are, say why you are emailing this business specifically, ask the question.
// It deliberately does NOT explain deliverables, packages or pricing — every
// extra sentence is another reason to close the tab instead of replying.
export function buildOutreachEmailPrompt(
  params: { business_name: string; category: string; suburb: string; city: string; description?: string; services?: string },
  contentType: ContentType
): string {
  const businessFacts = [
    `- Name: ${params.business_name}`,
    `- Category: ${params.category}`,
    `- Location: ${params.suburb} ${params.city}`,
    params.description ? `- Description: ${params.description}` : null,
    params.services ? `- Services: ${params.services}` : null,
  ].filter(Boolean).join('\n')

  const hasWebsiteFacts = Boolean(params.description || params.services)

  // One variant per lead, chosen here rather than left to the model — see
  // pickVariant in email-voice.ts for why. Different salts so a business doesn't
  // land on the same index for all four choices.
  const seed = params.business_name
  const intro = pickVariant(brandIntroOptions(contentType), seed, 'intro')
  const shape = pickVariant(REASON_SHAPES, seed, 'shape')
  const connector = pickVariant(REASON_CONNECTORS, seed, 'connector')
  const ask = pickVariant(INITIAL_ASKS, seed, 'ask')
  const subject = outreachSubjectFor(params.business_name)
  const contentFocus = getContentFocus(params.category, contentType)

  return `You are Owais. You run Aussie Venture. Write the first email to a business you have never spoken to before.

THE ONLY JOB OF THIS EMAIL IS TO GET A REPLY. You are not making a case and you are not selling. You are starting a conversation.

FACTS YOU MAY USE ABOUT YOURSELF (nothing else):
- Aussie Venture posts food, activities and travel from around Australia
- Around 650k followers across Instagram, TikTok and Facebook

FACTS YOU MAY USE ABOUT THEM (nothing else, and never invent more):
${businessFacts}

WRITE FOUR PARTS, IN THIS ORDER, AND NOTHING ELSE:

1. Greeting. "Hey ${params.business_name}," on its own line.

2. Who you are. Use this sentence, either as written or with very small wording changes:
   "${intro}"

3. Why you are emailing THIS business. This is the part that decides whether they reply. The honest reason is that you are covering this kind of business at the moment and theirs came up. Write that plainly. ${hasWebsiteFacts
    ? 'You have Description or Services facts above, so state ONE concrete detail from them, as an ordinary sentence. State it flatly. Do not rate it, judge it or compliment it. See SAYING THE DETAIL ABOUT THEM below — that rule decides this sentence, and an awkward one is worse than none.'
    : 'You have no Description or Services facts, so just name the kind of business and where they are. Do not invent a detail.'}
   Use this shape, and no other:
   ${shape}
   If that shape needs a connector, use "${connector}". Do not substitute a different one.
   Bad: "Your rooms look amazing and our audience would love them." (a compliment plus a claim about the audience)
   Bad: "You'd be a great fit for what we do." (argues the case, and uses banned wording)
   Bad: "I came across your website and was really impressed." (invented familiarity, banned wording)
   CATEGORY CHECK: ${params.category} belongs in ${contentFocus}. Keep the wording specific to that category. In particular, never call a salon, beauty studio, lash studio, spa or massage studio a "thing to do", an activity or an entertainment venue.

4. The ask. Use exactly this line, on its own line, and nothing else:
   "${ask}"

HARD LIMITS — break any of these and the email is wrong:
- 75 words maximum before the sign-off. Shorter is better. 45 words is a good email. There is no minimum.
- Two short paragraphs, three at the very most. No paragraph longer than two sentences.
- Do NOT mention any of this: price, budget, cost, free, paid, packages, options, what you would film or post, photos, video, assets, sponsored posts, visiting, coming in, remote, deliverables, timelines, or how the collab would work. All of that comes after they reply. If they want to know, they will ask.
- Do not claim to be based in, near, or visiting their suburb or city, unless the intro sentence you picked says Sydney and they are in Sydney.
- Do not mention food, dining or cuisine unless the Category says this is actually a food business.
- Nothing subjective or unverifiable about them: no "the best", "one of Sydney's favourites", "the most popular", "everyone's talking about".
- Never invent services, facilities, reviews, popularity or history beyond the facts above.

${VOICE_RULES}

${NO_SELLING_RULE}

${PLAIN_DETAIL_RULE}

${LENGTH_RULE}

${BANNED_WORDING}

SUBJECT LINE: use exactly this, nothing else: "${subject}"

${signOffRule(INITIAL_SIGN_OFF)}

Respond in JSON: { "subject": "...", "body": "..." }`
}

export async function writeOutreachEmail(params: {
  business_name: string
  category: string
  suburb: string
  city: string
  website: string
  description: string
  services: string
  content_type: string
}): Promise<{ subject: string; body: string }> {
  const contentType = normalizeContentType(params.content_type)
  const response = await rateLimitedCall(() =>
    anthropic.messages.create({
      model: SONNET_MODEL,
      max_tokens: 400,
      messages: [{ role: 'user', content: buildOutreachEmailPrompt(params, contentType) }],
    })
  )

  // The subject and the sign-off are decided by us, not by the model — see
  // outreachSubjectFor and enforceSignOff. Only the body is Claude's work.
  const subject = outreachSubjectFor(params.business_name)
  const text = response.content[0].type === 'text' ? response.content[0].text : ''
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as { body?: string }
      if (parsed.body?.trim()) {
        return { subject, body: enforceSignOff(parsed.body.trim(), INITIAL_SIGN_OFF) }
      }
    }
  } catch {
    // fallback
  }
  // Fallback obeys the same voice rules as the prompt — a malformed API response
  // must never be the reason a lead gets a worse-written email than everyone else.
  return {
    subject,
    body: `Hey ${params.business_name},\n\n${brandIntroOptions(contentType)[0]}\n\nWe're covering more ${params.category.toLowerCase()} at the moment and yours came up.\n\nWould you be interested in doing something together?\n\n${INITIAL_SIGN_OFF}`,
  }
}

// ─── Follow-up email writer ──────────────────────────────────────────────────

export interface FollowUpThreadEmail {
  type: string
  subject: string
  body: string
}

// Pure prompt builder — exported so tests can verify what Claude actually
// receives (e.g. that prior thread emails are present) without a live API call.
//
// The three follow-ups are NOT the pitch reworded three times. Each is a
// distinct beat:
//   FU1 (day 7)  — the first email may never have been seen; re-introduce, ask
//   FU2 (day 14) — one more check-in, made as cheap as possible to answer
//   FU3 (day 21) — close the loop so nobody is left waiting on anybody
//
// Every one of them opens by establishing who is writing. That is the change
// that matters: a follow-up must stand on its own, because the reader who is
// getting it is by definition the reader who did not engage with email one.
// "Just following up" is banned outright — it is only meaningful to someone who
// remembers what is being followed up on.
//
// Re-pitching remains the single biggest reply-rate killer, so the reminder is
// capped at one sentence and every stage below is still written as a ban list
// against re-selling rather than a brief to sell again.
export function buildFollowUpEmailPrompt(
  params: {
    business_name: string
    category: string
    suburb: string
    city: string
    website: string
    description: string
    services: string
    notes: string
  },
  followUpNumber: 1 | 2 | 3,
  history: FollowUpThreadEmail[]
): string {
  // Per-stage salt so the reminder is rephrased down the thread rather than
  // pasted three times — see reminderFor in email-voice.ts.
  const reminder = reminderFor(params.category, params.business_name, `fu${followUpNumber}`)
  const closing = fu3ClosingFor(params.business_name)

  const stageGuidance: Record<1 | 2 | 3, string> = {
    1: `THIS IS FOLLOW-UP 1, sent about a week after the first email.

ASSUME THEY NEVER SAW THE FIRST EMAIL. Do not write this as "following up". Write it so it makes complete sense as the first thing they ever read from you.

STRUCTURE — exactly this, nothing added:
- Line 1: "Hey ${params.business_name}," on its own line. Do not skip the greeting.
- Line 2: say the earlier email may not have got to them. State it as a possibility, not as a complaint. Vary the wording, e.g. "I emailed last week but it may not have reached you.", "My email from last week might have landed in the wrong inbox.", "Not sure my email last week made it through."
- Line 3: THE REMINDER. Use this sentence, either as written or with very small wording changes:
  "${reminder}"
- Line 4: one short declarative line saying the earlier email was about a collab with them. Do not ask whether they are interested in this line, and do not rebuild the pitch around it. For example: "I was asking about doing a collab with you."
- Line 5: ONE direct question, and that is the end of the email. Use exactly one of these and nothing else:
  "Would you be interested?"
  "Are you interested?"

FORBIDDEN IN THIS EMAIL, no exceptions:
- Do not write "just following up", "following up on", "circling back" or any variant. The reminder replaces them.
- Do not rebuild the pitch. One sentence of reminder is the entire allowance.
- Do not state your follower count or any number. The reminder names the platforms; that is the limit.
- Do not describe their business or use anything from the Description or Services facts.
- Do not reuse the wording of the ask from the first email. If the first email said "doing something together", say "interested" here instead.
- 45 to 80 words before the sign-off. Under 45 is fine if it reads well.`,
    2: `THIS IS FOLLOW-UP 2, sent about two weeks after the first email.

Its only job is to check in once more and make replying as cheap as possible. They may still never have read anything you sent, so this email also has to stand on its own.

STRUCTURE — exactly this, nothing added:
- Line 1: "Hey ${params.business_name}," on its own line.
- Line 2: a short line saying you're checking once more in case the earlier emails were missed or buried.
- Line 3: THE REMINDER. Use this sentence, either as written or with very small wording changes:
  "${reminder}"
- Line 4: the ask, and make answering it trivial. Use one of these, or something equally plain:
  "Is a collab something you'd be interested in? A yes or no is all I need."
  "Would you want to do something together? Even a no is fine."
  "Is this something you'd consider? Happy either way, I just need to know."
  "Would you be interested? One word back is plenty."

FORBIDDEN IN THIS EMAIL, no exceptions:
- Do NOT open by saying you haven't heard back. The last email in the sequence owns that line, and using it here means both emails open the same way. "Checking once more in case it was missed" is the framing.
- Do NOT add a clause explaining why replying helps them. No "then you've got something to say yes or no to", no "so I can plan around it". That is a copywriter explaining the tactic inside the email. Ask and stop.
- Do not state your follower count or any number.
- Do not describe their business back to them.
- Do not imply this is the last email.
- 40 to 65 words before the sign-off. This is the shortest email in the sequence and that is the point.`,
    3: `THIS IS FOLLOW-UP 3, THE LAST EMAIL, sent about three weeks after the first.

Its job is to close the loop. Nobody should be left waiting on anybody. You are telling them you'll mark the enquiry closed and giving them one easy way to stop that. It is a courtesy, not a threat and not a last chance.

It still carries the reminder, because this may genuinely be the first email of yours they open, and a closing note from a stranger they can't identify is worse than no note at all.

STRUCTURE — exactly this, nothing added:
- Line 1: "Hey ${params.business_name}," on its own line.
- Line 2: you haven't heard back, so you're closing it off. Use exactly this line, on its own line:
  "${closing}"
  It is first person and it is active. "I haven't heard back" is a person who checked. "No reply has come through" is a system filing a report, and that is not what you are.
- Line 3: THE REMINDER. Use this sentence, either as written or with very small wording changes:
  "${reminder}"
- Line 4: a reply reopens it, and then stop. Use one of these, or something equally plain:
  "If you want to pick it up later, just reply."
  "Reply any time if that changes."
  "If it's worth a look later on, just reply and I'll pick it back up."
  "If I've got that wrong, reply and I'll pick it back up."

FORBIDDEN IN THIS EMAIL, no exceptions:
- Do not reword line 2. Do not replace "I haven't heard back" with a passive version of it: no "no reply has come through", "nothing has come back", "nothing further has been heard", "your response hasn't arrived".
- No urgency. No deadline. No "last chance", no "before I close the file", no "final opportunity".
- No guilt. Do not mention how many times you've emailed, and do not apologise for emailing.
- No sadness or disappointment. No "sorry to hear", no "shame", no "that's a pity".
- Do not re-explain the offer or anything from the facts. The reminder is the whole allowance.
- Do not state your follower count or any number.
- Do not wish them well for their business, their team or their year. It reads as filler.
- 40 to 70 words before the sign-off. Four short lines is the whole email.`,
  }

  const facts = [
    `- Name: ${params.business_name}`,
    `- Category: ${params.category}`,
    `- Location: ${params.suburb}, ${params.city}`,
    params.website ? `- Website: ${params.website}` : null,
    params.description ? `- Description: ${params.description}` : null,
    params.services ? `- Services: ${params.services}` : null,
    params.notes ? `- Internal notes: ${params.notes}` : null,
  ].filter(Boolean).join('\n')

  const thread = history
    .map((h, i) => `[Email ${i + 1} — ${h.type}]\nSubject: ${h.subject}\n${h.body}`)
    .join('\n\n')

  return `You are Owais. You run Aussie Venture. You are writing a short reply in a thread you started with a business that has not answered you.

FACTS ABOUT THE BUSINESS (background only, so you don't contradict yourself — see the stage rules below for whether you're allowed to use any of it):
${facts}

THE THREAD SO FAR, oldest first. Read it before you write:
${thread}

${stageGuidance[followUpNumber]}

DO NOT REPEAT THE THREAD, WITH ONE EXCEPTION:
- The reminder sentence is the exception. It is meant to repeat, because the reader may not have opened anything before this. Include it as instructed above.
- Everything else: do not reuse an opening line, a closing line or a turn of phrase from any email above.
- Do not restate the reason you originally emailed, the detail you used about their business, or the follower count. Once was enough.
- If you find yourself writing a version of a sentence that's already up there, and it isn't the reminder, cut it.

THIS EMAIL MUST STAND ALONE:
- Write as though this is the only email of yours they will ever read. Do not rely on them remembering the first one.
- Never write "as mentioned", "as I said", "per my last email", "just following up" or anything that only makes sense to someone who read an earlier email.

HARD LIMITS — break any of these and the email is wrong:
- Two or three short paragraphs. No paragraph longer than two sentences.
- Only the facts above exist. Never invent a prior conversation, a phone call, a reply, a referral or a deadline.
- Do not add a subject line. You are replying in the existing thread.

${VOICE_RULES}

${NO_SELLING_RULE}

${NO_COMMERCIALS_RULE}

${LENGTH_RULE}

${BANNED_WORDING}

${signOffRule(FOLLOW_UP_SIGN_OFF)}

Respond in JSON: { "body": "..." }`
}

// ─── Haiku email extractor ───────────────────────────────────────────────────

export async function extractEmailWithHaiku(content: string, businessName: string): Promise<string | null> {
  const response = await rateLimitedCall(() =>
    anthropic.messages.create({
      model: HAIKU_MODEL,
      max_tokens: 64,
      messages: [
        {
          role: 'user',
          content: `Find a contact email address for "${businessName}" in this text. Return ONLY the email address, nothing else. If no email is found, return "none".\n\n${content.slice(0, 3000)}`,
        },
      ],
    })
  )

  const text = response.content[0].type === 'text' ? response.content[0].text.trim() : ''
  if (text && text.toLowerCase() !== 'none' && text.includes('@') && !text.includes(' ') && text.length < 100) {
    return text
  }
  return null
}

// ─── Agentic email search (legacy) ───────────────────────────────────────────

interface AgentDecision {
  action: 'found' | 'fetch_url' | 'search_google' | 'not_found'
  email?: string
  url?: string
  search_query?: string
}

async function fetchPageText(url: string): Promise<string> {
  try {
    const normalised = url.startsWith('http') ? url : `https://${url}`
    const res = await fetch(normalised, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ReachAgentBot/1.0)' },
      signal: AbortSignal.timeout(10_000),
    })
    const html = await res.text()
    return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 4000)
  } catch {
    return ''
  }
}

async function searchWeb(query: string): Promise<string> {
  try {
    const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ReachAgentBot/1.0)',
        Accept: 'text/html',
      },
      signal: AbortSignal.timeout(10_000),
    })
    const html = await res.text()
    return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 4000)
  } catch {
    return ''
  }
}

function parseDecision(text: string): AgentDecision {
  try {
    const m = text.match(/\{[\s\S]*?\}/)
    if (m) return JSON.parse(m[0]) as AgentDecision
  } catch {}
  return { action: 'not_found' }
}

export async function agenticEmailSearch(params: {
  business_name: string
  website_url: string
  category: string
  homepage_content: string
}): Promise<{ email: string | null; method: string; rounds: number }> {
  const MAX_ROUNDS = 3

  const SYSTEM = `You are a research agent that finds contact email addresses for businesses. Respond in valid JSON only — no other text.`

  const firstPrompt = `Find the contact email for this business.

Business: ${params.business_name}
Website: ${params.website_url}
Category: ${params.category}

Homepage content:
${params.homepage_content}

Choose ONE action and respond with JSON only:
- Found an email → {"action":"found","email":"email@domain.com"}
- Need to fetch a subpage → {"action":"fetch_url","url":"/contact"}
- Need an online search → {"action":"search_google","search_query":"${params.business_name} contact email"}
- Cannot find → {"action":"not_found"}`

  const messages: { role: 'user' | 'assistant'; content: string }[] = [
    { role: 'user', content: firstPrompt },
  ]

  let method = 'not_found'

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const response = await rateLimitedCall(() =>
      anthropic.messages.create({
        model: SONNET_MODEL,
        max_tokens: 256,
        system: SYSTEM,
        messages,
      })
    )

    const raw = response.content[0].type === 'text' ? response.content[0].text : '{}'
    const decision = parseDecision(raw)

    console.log(`[email-agent] round=${round} action=${decision.action} email=${decision.email ?? '-'}`)

    if (decision.action === 'found' && decision.email) {
      if (round === 1) method = 'homepage'
      else if (method !== 'google_search') method = 'subpage'
      return { email: decision.email, method, rounds: round }
    }

    if (decision.action === 'not_found') {
      break
    }

    // Execute the suggested action
    let fetchedContent = ''

    if (decision.action === 'fetch_url' && decision.url) {
      let target = decision.url
      if (!target.startsWith('http')) {
        try {
          const base = new URL(
            params.website_url.startsWith('http') ? params.website_url : `https://${params.website_url}`
          )
          target = base.origin + (decision.url.startsWith('/') ? decision.url : `/${decision.url}`)
        } catch {
          target = params.website_url + decision.url
        }
      }
      fetchedContent = await fetchPageText(target)
      method = 'subpage'
    } else if (decision.action === 'search_google' && decision.search_query) {
      fetchedContent = await searchWeb(decision.search_query)
      method = 'google_search'
    }

    messages.push({ role: 'assistant', content: raw })

    if (!fetchedContent) {
      messages.push({
        role: 'user',
        content: 'That returned no content. Try a different approach or return {"action":"not_found"}.',
      })
      continue
    }

    messages.push({
      role: 'user',
      content: `Content from ${decision.action === 'search_google' ? 'search results' : 'that page'}:

${fetchedContent}

Now decide. JSON only: {"action":"found","email":"..."} or {"action":"fetch_url","url":"..."} or {"action":"search_google","search_query":"..."} or {"action":"not_found"}`,
    })
  }

  return { email: null, method: 'not_found', rounds: MAX_ROUNDS }
}

// ─── Reactivation email writer ───────────────────────────────────────────────

// Email 5 of the sequence, 90+ days after the thread went quiet.
//
// The old version of this prompt banned every reference to prior contact, so it
// pretended to be a cold email to a business we had emailed four times. That is
// a lie the recipient can check in two clicks, and getting caught in it is worse
// than the silence it was trying to paper over.
//
// It is now written as a re-introduction: assume they remember nothing, say who
// you are properly, own the earlier attempt in one clause without apologising or
// guilt-tripping, then ask the only genuinely new question available — whether
// the timing is better now. Everything else is the same voice as email one,
// including the full sign-off, because after three months this is effectively a
// first contact again and the reader needs somewhere to go and check who we are.
export function buildReactivationEmailPrompt(
  params: { business_name: string; category: string; suburb: string; city: string },
  contentType: ContentType
): string {
  const seed = params.business_name
  const intro = pickVariant(brandIntroOptions(contentType), seed, 'reactivation-intro')
  const ask = pickVariant(REACTIVATION_ASKS, seed, 'reactivation-ask')
  const subject = reactivationSubjectFor(params.business_name)
  const contentContext = getReactivationFocus(params.category, contentType)
  const context = reactivationContextFor(params.business_name, contentContext)

  return `You are Owais. You run Aussie Venture. You emailed this business a few months ago about a collab and never heard back. You are writing to them once more, now that a lot of time has passed.

THE ONLY JOB OF THIS EMAIL IS TO GET A REPLY. Treat it as a fresh introduction, not as a follow-up. Assume they remember nothing about you and never read a word you sent.

IT ALSO HAS TO SOUND LIKE A PERSON WHO REMEMBERED THEM. Three months have gone by and you're writing again because you're doing more of this kind of thing at the moment. That is a normal, human reason. Say it the way you'd say it in conversation. Do not describe it as a round, a batch, a campaign or a list, and do not describe them in the words a directory would use.

FACTS YOU MAY USE ABOUT YOURSELF (nothing else):
- Aussie Venture posts food, activities and travel from around Australia
- Around 650k followers across Instagram, TikTok and Facebook
- You're covering more ${contentContext} at the moment

FACTS YOU MAY USE ABOUT THEM (nothing else, and never invent more):
- Name: ${params.business_name}
- Category: ${params.category}
- Location: ${params.suburb} ${params.city}

WRITE FOUR PARTS, IN THIS ORDER, AND NOTHING ELSE:

1. Greeting. "Hey ${params.business_name}," on its own line.

2. Who you are, in full. This is a re-introduction, so it gets the proper version, not a one-line reminder. Use this sentence, either as written or with very small wording changes:
   "${intro}"

3. The honest situation, in two short sentences and no more:
   - You emailed a few months back about working together and never heard anything. Say it plainly and move on. One clause, no apology, no guilt, no "I know you're busy".
   - Why you're writing now. Use this sentence, either as written or with very small wording changes:
     "${context}"

4. The ask. It is about TIMING, not about the collab. Use exactly this line, on its own line, and nothing else:
   "${ask}"

HARD LIMITS — break any of these and the email is wrong:
- 65 to 100 words before the sign-off. Under 65 is fine if it reads well. Do not pad to reach it.
- Two or three short paragraphs. No paragraph longer than two sentences.
- Do NOT mention price, budget, cost, free, paid, packages, options, deliverables, what you would film or post, timelines, or how the collab would work. All of that comes after they reply.
- Do not pretend you have never emailed them. Do not dwell on it either. One clause is the whole allowance.
- No guilt, no pressure, no urgency, no deadline. No "last time I'll ask", no "one final attempt".
- Do not ask why they didn't reply, and do not suggest they should have.
- Do not claim to be based in, near, or visiting their suburb or city, unless the intro sentence you picked says Sydney and they are in Sydney.
- Do not mention food, dining or cuisine unless the Category says this is actually a food business.
- Never invent services, facilities, reviews, popularity or history beyond the facts above.

${VOICE_RULES}

${NO_SELLING_RULE}

${LENGTH_RULE}

${BANNED_WORDING}

SUBJECT LINE: use exactly this, nothing else: "${subject}"

${signOffRule(INITIAL_SIGN_OFF)}

Respond in JSON: { "subject": "...", "body": "..." }`
}

export async function writeReactivationEmail(params: {
  business_name: string
  category: string
  suburb: string
  city: string
  content_type: string
}): Promise<{ subject: string; body: string }> {
  const contentType = normalizeContentType(params.content_type)
  const contentContext = getReactivationFocus(params.category, contentType)
  const subject = reactivationSubjectFor(params.business_name)

  return {
    subject,
    body: `Hey ${params.business_name},\n\n${brandIntroOptions(contentType)[0]}\n\nI emailed you about a collab a few months back and never heard anything. ${reactivationContextFor(params.business_name, contentContext)}\n\n${pickVariant(REACTIVATION_ASKS, params.business_name, 'reactivation-ask')}\n\n${INITIAL_SIGN_OFF}`,
  }
}

// ─── DM writer ───────────────────────────────────────────────────────────────

export function buildOutreachDMPrompt(
  params: { business_name: string; suburb: string; city: string; category: string },
  brandDesc: string,
  pitch: string
): string {
  return `You're Owais. You run Aussie Venture, ${brandDesc} with 650K+ followers across Facebook, Instagram and TikTok. Write a short Instagram DM to this business.

Business: ${params.business_name}, ${params.suburb} ${params.city}
Category: ${params.category}

Pitch angle: ${pitch}

Rules:
- Max 2-3 sentences
- Sound like a real person, not a platform
- No em dashes, no bullet points, no corporate language
- No "I wanted to reach out", no "I came across your page"
- You may mention 650K+ followers once if it adds credibility
- NEVER mention free, no cost, no charge, or anything being free
- NEVER say "paid collab" - use "sponsored feature" or "collab" instead
- Never state a price
- Never say "I'm based in ${params.city}" or otherwise claim you live in, are based in, or are physically located in the business's city — Aussie Venture's audience is national, don't invent a location for yourself
- Never invent familiarity with the business — you only know its name, category and suburb. No claims implying you already know their page, food, or space
- Casual and direct
- End with "Would you be keen?" or "Keen to work together?"

Respond with just the DM text, nothing else.`
}

export async function writeOutreachDM(params: {
  business_name: string
  suburb: string
  city: string
  category: string
  content_type: string
}): Promise<string> {
  const contentType = normalizeContentType(params.content_type)
  const brandDesc = getBrandDescription(params.category, contentType)
  const pitch = getCategoryPitch(params.category, contentType)

  const response = await rateLimitedCall(() =>
    anthropic.messages.create({
      model: SONNET_MODEL,
      max_tokens: 200,
      messages: [{ role: 'user', content: buildOutreachDMPrompt(params, brandDesc, pitch) }],
    })
  )

  return response.content[0].type === 'text' ? response.content[0].text : ''
}
