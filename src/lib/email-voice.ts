// Shared Aussie Venture sequence copy: follow-up/reactivation voice rules plus
// the deterministic subjects, sign-offs and brand facts used by every stage.
// The initial AI writer has its own system-level voice contract in
// ai/email-generation.ts because its personalisation and variation job differs
// from the threaded stages.
//
// Why this file exists: the ban list and style rules used to be copy-pasted
// into each AI prompt builder, so a new banned phrase had to be added
// in three places and drifted between them. Anything that applies to more than
// one email in the sequence belongs here; anything specific to one stage stays
// with that stage's prompt.
//
// The goal of the whole sequence is REPLY RATE, not persuasion. Every rule below
// exists to make the email read like one person typing quickly to another
// person, not like a brand talking to a prospect.

import type { ContentType } from './content-type'
import { getCategoryReminderFocus } from './category-copy'

// ─── Voice ───────────────────────────────────────────────────────────────────

export const VOICE_RULES = `VOICE — this is the most important part. Get this wrong and the email is wrong:
- You are one person emailing another person. Not a brand, not an agency, not a marketer.
- Write it the way you would actually type it in under a minute. Plain Australian English.
- Short sentences. One idea per sentence.
- Every sentence must do a job. If a sentence only exists to sound nice, delete it.
- Almost no adjectives. No "genuinely", "truly", "really", "absolutely", "incredibly".
- Do not compliment the business. State a fact instead of an opinion.
- Do not argue the case for the collab. Do not explain why it is a good idea. Just ask.
- Do not perform enthusiasm. No excitement you would not actually feel while typing.
- No em dashes (the "—" character). Use a full stop or a comma.
- No exclamation marks.
- No bullet points, no headings, no bold, no emoji.
- No rhetorical questions. The only question is the direct one at the end.
- Contractions are good ("I'm", "you're", "we've"). Formal phrasing is not.`

export const BANNED_WORDING = `BANNED WORDING — never write any of these, or anything that means the same thing:
- "our audience would love this", "our followers would love", "our audience goes crazy for"
- "our audience is always looking for", "our audience enjoys", "our followers enjoy"
- "exactly the kind of content we create", "exactly what our audience wants"
- "films brilliantly", "photographs beautifully", "looks great on camera"
- "people can picture themselves", "perfect fit", "great fit", "ideal fit", "good fit"
- "authentic experience", "highly engaging", "genuinely engaged audience"
- "we'd love to shine a light on", "we'd love to work together", "we'd love to feature you"
- "we think this would resonate", "this would resonate with our audience"
- "worth a quick chat", "quick chat", "jump on a call", "hop on a call"
- "just checking in", "touching base", "circling back", "bumping this up", "bumping this"
- "following up again", "thought I'd reach out", "I came across", "I stumbled across"
- "no rush", "whenever you're ready", "at your convenience", "when you get a chance"
- "I hope this email finds you well", "I wanted to reach out", "I wanted to see if"
- "leverage", "synergy", "unlock", "elevate", "showcase", "amplify", "curated",
  "immersive", "vibrant", "iconic", "hidden gem", "must-visit", "game changer",
  "unique experience", "one of a kind", "next level"
- "excited", "thrilled", "buzzing", "stoked", "can't wait"
- "the [X] space", "the [X] vertical", "the [X] sector", "operators in your space".
  Say "nail salons", not "the nail salon space". Nobody who runs one calls it that.
- Passive reports about the silence. Never "no reply has come through", "nothing has
  come back", "no response has been received", "your reply hasn't arrived",
  "nothing further has been heard". Say "I haven't heard back". You are a person who
  checked their inbox, not a system logging a missed SLA.
- Campaign language. Never "another round of", "the next batch of", "a fresh round
  of", "our current campaign", "this round of outreach", "our outreach". It tells
  the reader they're a row in a spreadsheet.
- Any sentence about engagement, reach, views, impressions or how well content performs.
- Any claim about what your audience wants, likes, needs or is looking for.
- Any claim that implies you already know the business beyond the facts you were given.
  No "I've been following you", "I've seen your page", "your food looks amazing",
  "you keep coming up", "I've heard great things".`

// The rule that catches the single most common AI tell in this sequence: the
// model wants to justify the collab. It must not. Stated separately because it
// needs to survive being skimmed.
export const NO_SELLING_RULE = `DO NOT SELL:
- Do not describe your audience.
- Do not describe the business back to them.
- Do not say why the two would work well together.
- Asking is the whole job. A short email that just asks beats a good argument.`

// Applies to every email after the first: FU1, FU2, FU3 and the reactivation.
//
// FU1 used to end "Happy to send our package options over if you want a look."
// It reads helpful and it isn't. It puts two questions in one email — are you
// interested, and do you want the pricing — and a reader who is only mildly
// curious now has to decide both before replying, so they reply to neither. It
// also reframes the email from "one person asking another person a question"
// into "a supplier presenting an offer", which is the frame the whole sequence
// exists to stay out of. Commercials are a conversation you have with someone
// who has already said yes to talking.
export const NO_COMMERCIALS_RULE = `NO COMMERCIALS — this email is only trying to start a conversation:
- Do not mention packages, package options, pricing, prices, rates, cost, budget, fees, what's included, deliverables, or an offer of any kind. Not one word about any of it.
- Do not offer to send anything through. No "happy to send our options over", no "I can send details", no "want me to send more info", no "I'll send a rundown".
- Do not describe what you would film, post or make for them.
- The only thing you are asking is whether they're interested. Everything else happens after they reply.`

// Word bands exist to stop the model writing an essay. Read as a target rather
// than a ceiling they do the opposite: the model finishes a good short email,
// counts 48 words against a floor of 70, and pads. What it pads with is always
// the same thing — a sentence explaining why replying is worth their while, or a
// line describing the business back to them — because that's the only material
// left once the actual content is written. Both are banned everywhere else in
// this file, so the floor was quietly re-introducing them.
export const LENGTH_RULE = `LENGTH — the band is a ceiling with a rough floor, never a target:
- Going under the band is fine. Going under it because the email says everything it needs to in fewer words is good.
- Never add a sentence to reach a word count. If you're short, you're finished.
- Padding shows up as a line about why replying helps them, or a line describing their business back to them. Both are banned. Cut instead of filling.`

// ─── Brand intro ─────────────────────────────────────────────────────────────

// Plain-English ways to say who Aussie Venture is, in the first person, without
// the words "platform", "brand" or "content creator". Given to the model as a
// pick-one list so 12 categories don't all open with a byte-identical sentence
// while still never drifting into agency wording.
//
// visit/remote drives the Sydney vs Australia framing, same rule as everywhere
// else in the codebase (see content-type.ts) — visit leads get in-person content
// so being Sydney based is relevant to them; remote leads should not be told
// we're local to them.
export function brandIntroOptions(contentType: ContentType): string[] {
  const followers = 'nearly 600K followers across Instagram, TikTok and Facebook'
  if (contentType === 'visit') {
    return [
      `I'm Owais, and I run Aussie Venture. We're based in Sydney and post food, activities and travel from around Australia. We have ${followers}.`,
      `I'm Owais from Aussie Venture. We're a Sydney page posting food, activities and travel around Australia, with ${followers}.`,
      `I'm Owais. I run Aussie Venture, a Sydney page that posts food, activities and travel from around the country. We have ${followers}.`,
    ]
  }
  return [
    `I'm Owais, and I run Aussie Venture. We post food, activities and travel from around Australia. We have ${followers}.`,
    `I'm Owais from Aussie Venture. We post food, activities and travel around Australia, with ${followers}.`,
    `I'm Owais. I run Aussie Venture, where we post food, activities and travel from around the country. We have ${followers}.`,
  ]
}

// ─── Category reminder ───────────────────────────────────────────────────────

// The one sentence every follow-up and the reactivation email must carry.
//
// Why it exists: the old sequence assumed the reader had the first email in
// front of them, so follow-up 2 was eight words with no context at all. That is
// only true for the reader who opened the first email, and the whole reason a
// follow-up is being sent is that they probably didn't. Anyone reading a
// follow-up cold now gets who we are, what we make and where we post it.
//
// It is ONE sentence and that is the ceiling. Re-running the pitch, the follower
// count or the reason for emailing is what makes a sequence read as marketing,
// which is the thing this whole file is built to avoid. The reminder says who is
// typing; it does not re-argue the case.
//
// The content noun comes from the category (see getCategoryReminderFocus), so
// restaurants get "food content" and escape rooms get "content featuring
// attractions and experiences" without either being written down here.
export function brandReminderOptions(category: string): readonly string[] {
  const focus = getCategoryReminderFocus(category)
  return [
    `I'm Owais from Aussie Venture. We create ${focus} across Instagram, TikTok and Facebook.`,
    `I'm Owais from Aussie Venture. We make ${focus} for Instagram, TikTok and Facebook.`,
    `I'm Owais, I run Aussie Venture. We post ${focus} on Instagram, TikTok and Facebook.`,
  ]
}

// Salted per stage so the same reminder sentence isn't repeated verbatim three
// times inside one thread — a reader who DID see the earlier emails should see
// it rephrased, not pasted.
export function reminderFor(category: string, businessName: string, stageSalt: string): string {
  return pickVariant(brandReminderOptions(category), businessName, `reminder:${stageSalt}`)
}

// ─── Sign-offs ───────────────────────────────────────────────────────────────

// The initial email carries the links, because at that point the reader has no
// idea who is emailing them and needs somewhere to go and check. Deliberately
// short: a seven-line link block reads as a marketing footer, which undoes the
// work the body just did.
export const INITIAL_SIGN_OFF = `Cheers,
Owais
Aussie Venture
aussieventure.com
instagram.com/aussie.venture`

// Follow-ups are replies inside a thread the reader already has the links in.
// Signing them like a first contact is the clearest tell that an outreach tool
// sent them rather than a person.
export const FOLLOW_UP_SIGN_OFF = `Cheers,
Owais`

export function signOffRule(signOff: string): string {
  return `Sign off with exactly this, every line, nothing added and nothing removed:
${signOff}`
}

// Replaces whatever sign-off the model produced with the real one.
//
// This is not belt-and-braces, it fixes an observed failure: asked to reproduce
// the sign-off verbatim, the model returned "austieventure.com". A typo in a domain
// is worse than any wording problem in the body, because the one reader who
// tries to go and check who emailed them lands nowhere. The sign-off is fixed
// text, so there is no reason to let a language model retype it.
export function enforceSignOff(body: string, signOff: string): string {
  const lines = body.split('\n')
  const build = (upTo: number) => `${lines.slice(0, upTo).join('\n').trimEnd()}\n\n${signOff}`

  // A sign-off is a valediction ALONE on its line. Matching the word anywhere in
  // a line would eat a real sentence: "Cheers for the quick reply earlier." is
  // body text, not a sign-off. Searching backwards so a body that says "thanks"
  // early on still cuts at the actual sign-off.
  const ALONE = /^[ \t]*(cheers|thanks|thank you|regards|kind regards|best|all the best|warm regards)[ \t]*,?[ \t]*$/i
  for (let i = lines.length - 1; i >= 0; i--) {
    if (ALONE.test(lines[i])) return build(i)
  }

  // Second pass for valedictions the model padded ("Thanks so much,"). Only
  // treated as a sign-off when "Owais" follows on its own line just below,
  // which is the shape of a signature and not of a sentence.
  const OPENS_WITH = /^[ \t]*(cheers|thanks|thank you|regards|kind regards|best|all the best|warm regards)\b/i
  const NAME_ALONE = /^[ \t]*Owais[ \t]*$/i
  for (let i = lines.length - 1; i >= 0; i--) {
    if (OPENS_WITH.test(lines[i]) && lines.slice(i + 1, i + 3).some((l) => NAME_ALONE.test(l))) {
      return build(i)
    }
  }

  return `${body.trimEnd()}\n\n${signOff}`
}

// ─── Per-lead variation ──────────────────────────────────────────────────────

// Each lead gets its own independent AI generation call, so the model has no way to
// know what it wrote for the last hundred businesses. Left to itself it
// converges hard: three consecutive previews came back with the same paragraph
// shape, the same connector, the same ask and the same subject line. No single
// recipient can tell, but the outbox reads as one template, and any reply-rate
// gain from sounding human is lost the moment two owners in the same suburb
// compare notes.
//
// So the choice is made here and handed to the model, seeded off the business
// name: stable per lead (regenerating an email produces the same one) and
// evenly spread across the list.
function stableHash(seed: string): number {
  let h = 5381
  for (let i = 0; i < seed.length; i++) h = ((h << 5) + h + seed.charCodeAt(i)) | 0
  return Math.abs(h)
}

export function pickVariant<T>(options: readonly T[], seed: string, salt = ''): T {
  return options[stableHash(`${seed}${salt}`) % options.length]
}

// The opening line of the last email. Shared with the static template so the
// fallback and the generated version close a thread the same way.
//
// It has to be first person and active. Left to itself the model reaches for
// "No reply has come through" or "Nothing has come back on this", which is the
// register of a system reporting a state, not a person who has stopped waiting.
// The difference matters more here than anywhere else in the sequence: this is
// the email most likely to get a reply out of the ones nobody answered, and it
// only works if it reads as a person quietly wrapping something up.
export const FU3_CLOSING_LINES: readonly string[] = [
  "I haven't heard back, so I'll close this enquiry off at my end.",
  "I haven't heard anything back, so I'll close this one off at my end.",
  "Since I haven't heard back, I'll close this off at my end.",
  "I haven't heard back on this, so I'll close it off at my end.",
]

export function fu3ClosingFor(businessName: string): string {
  return pickVariant(FU3_CLOSING_LINES, businessName, 'fu3-closing')
}

// Subject lines a person would actually type. Deliberately dull: a subject that
// looks like it came out of a campaign tool gets the email read as one.
function subjectOptions(businessName: string): readonly string[] {
  return [
    'Collab?',
    'Quick question',
    'Collab with Aussie Venture?',
    `Aussie Venture x ${businessName}`,
    'Working together?',
    'Quick one about a collab',
  ]
}

// The subject is decided here, not by the model, and the send path uses this
// rather than whatever came back in the JSON. Same reasoning as enforceSignOff:
// it's a fixed choice from a fixed pool, and letting the model retype it only
// creates opportunities for Title Case and exclamation marks to creep back in.
export function outreachSubjectFor(businessName: string): string {
  return pickVariant(subjectOptions(businessName), businessName, 'subject')
}

// ─── Reactivation ────────────────────────────────────────────────────────────

// The reactivation email lands 90+ days after the thread went quiet, so it is a
// fresh send with a fresh subject, never "Re:" anything. Threading it under a
// three-month-old subject line is how a re-approach reads as nagging.
function reactivationSubjectOptions(businessName: string): readonly string[] {
  return [
    'Better timing now?',
    'Worth another look?',
    'Collab, take two?',
    `Aussie Venture and ${businessName}`,
    'Another go at a collab?',
  ]
}

export function reactivationSubjectFor(businessName: string): string {
  return pickVariant(reactivationSubjectOptions(businessName), businessName, 'reactivation-subject')
}

// The reactivation ask is about TIMING, not about the collab. They already
// declined by silence once; the only new information on offer is that months
// have passed. Asking the original question again ignores that.
// The one sentence in the reactivation email that says what we're up to now.
//
// This used to be built in the prompt as "another round of ${focus}", where focus
// was a phrase like "Sydney halal dining spots". Two problems in five words. The
// reader is being told, in writing, that they are an item in a batch — "another
// round" is scheduling language, and no restaurant owner thinks of themselves as
// a Sydney halal dining spot. Both are internal vocabulary that leaked into the
// copy because the same string was convenient for a variable name and a sentence.
//
// The focus phrase is now something a person would actually say out loud (see
// getReactivationFocus in category-copy.ts) and it goes in a sentence a person
// would actually write.
export function reactivationContextOptions(focus: string): readonly string[] {
  return [
    `We're covering more ${focus} at the moment, so you came to mind again.`,
    `I'm planning more coverage of ${focus} over the next few months, so I thought I'd try you again.`,
    `We're featuring more ${focus} now, so you came to mind again.`,
    `I'm working on more coverage of ${focus} at the moment, so I thought I'd come back to you.`,
  ]
}

export function reactivationContextFor(businessName: string, focus: string): string {
  return pickVariant(reactivationContextOptions(focus), businessName, 'reactivation-context')
}

export const REACTIVATION_ASKS: readonly string[] = [
  'Is now a better time?',
  'Would now suit better?',
  'Is this a better time to ask?',
  'Any better timing on your end?',
  'Would the timing be any better now?',
  'Is it worth another look now?',
]
