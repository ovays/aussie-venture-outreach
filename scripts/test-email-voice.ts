/**
 * scripts/test-email-voice.ts
 *
 * Pure-logic tests for the shared outreach voice layer (src/lib/email-voice.ts)
 * and the parts of the email writers that no longer trust the model:
 *   - enforceSignOff replaces whatever the model produced with the real sign-off
 *     (fixes an observed "austieventure.com" typo in a live generation)
 *   - outreachSubjectFor / pickVariant are deterministic per lead but spread
 *     across the option pool, so regenerating an email gives the same one while
 *     the outbox as a whole doesn't read as one template
 *   - the static follow-up templates stay distinct per stage, get shorter each
 *     stage, and contain none of the banned wording
 *
 * No network, no DB, and no AI provider credentials needed.
 *
 * Run: npm run test:email-voice
 */

import {
  enforceSignOff,
  outreachSubjectFor,
  pickVariant,
  INITIAL_SIGN_OFF,
  FOLLOW_UP_SIGN_OFF,
  VOICE_RULES,
  NO_COMMERCIALS_RULE,
  LENGTH_RULE,
  FU3_CLOSING_LINES,
  brandReminderOptions,
  reminderFor,
  REACTIVATION_ASKS,
  reactivationContextOptions,
  reactivationSubjectFor,
} from '@/lib/email-voice'
import { getReminderFamily, getReactivationFocus } from '@/lib/category-copy'
import { buildFollowUpEmail } from '@/lib/followup-email-templates'
import {
  buildOutreachEmailPrompt,
  buildFollowUpEmailPrompt,
  buildReactivationEmailPrompt,
  OUTREACH_EMAIL_SYSTEM_PROMPT,
} from '@/ai/workflows'
import type { FollowUpType } from '@/lib/followup-eligibility'

let failures = 0

function assert(condition: boolean, message: string, detail?: string): void {
  if (condition) {
    console.log(`  ✓ ${message}`)
  } else {
    console.log(`  ✗ ${message}${detail ? ` — got: ${detail}` : ''}`)
    failures++
  }
}

// Mirrors BANNED_WORDING in src/lib/email-voice.ts. Anything matching here in
// our own hand-written copy is a bug in the copy, not in the model.
const BANNED: RegExp[] = [
  /\b(perfect|great|ideal|good) fit\b/i,
  /our (audience|followers)\b/i,
  /\bresonate\b/i,
  /\bauthentic\b/i,
  /\bengag(ing|ement)\b/i,
  /\bshowcase\b/i,
  /\b(immersive|vibrant|iconic|curated|elevate|amplify|leverage|synergy)\b/i,
  /\b(excited|thrilled|buzzing|stoked)\b/i,
  /just checking in|touching base|circling back|bumping this/i,
  /worth a quick chat|quick chat/i,
  /we'?d love to\b/i,
  /no rush|whenever you'?re ready|at your convenience/i,
  /following up again|thought I'?d reach out|I came across/i,
  /hope this (email )?finds you well/i,
  /—/,
  /!/,
]

function test1_enforceSignOff(): void {
  console.log('\n[1] enforceSignOff replaces the model\'s sign-off with the real one')

  // The exact failure this was written for: model retyped the domain wrong.
  const typoed = `Hey Salty Fox,\n\nShort body.\n\nCheers,\nOwais\nAussie Venture\naustieventure.com\ninstagram.com/aussie.venture`
  const fixed = enforceSignOff(typoed, INITIAL_SIGN_OFF)
  assert(!fixed.includes('austieventure'), 'a typo\'d domain in the model\'s sign-off is removed')
  assert(fixed.includes('aussieventure.com'), 'the correct domain is present')
  assert(fixed.endsWith(INITIAL_SIGN_OFF), 'body ends with the exact canonical sign-off')
  assert(fixed.startsWith('Hey Salty Fox,'), 'the body above the sign-off is untouched')
  assert(
    (fixed.match(/Cheers,/g) ?? []).length === 1,
    'exactly one "Cheers," survives (the old one is cut, not appended to)'
  )

  // Other sign-off wordings the model might reach for must also be replaced.
  for (const opener of ['Thanks,', 'Regards,', 'Kind regards,', 'All the best,', 'Best,']) {
    const out = enforceSignOff(`Hey there,\n\nBody.\n\n${opener}\nOwais\nsomething wrong`, FOLLOW_UP_SIGN_OFF)
    assert(out === `Hey there,\n\nBody.\n\n${FOLLOW_UP_SIGN_OFF}`, `"${opener}" is replaced too`, JSON.stringify(out))
  }

  // A body with no sign-off at all must still get one, not be mangled.
  const bare = enforceSignOff('Hey there,\n\nWant me to send our options through?', FOLLOW_UP_SIGN_OFF)
  assert(bare === `Hey there,\n\nWant me to send our options through?\n\n${FOLLOW_UP_SIGN_OFF}`,
    'a body with no sign-off gets the canonical one appended', JSON.stringify(bare))

  // "Cheers" inside a sentence must not be mistaken for the sign-off line.
  const inline = enforceSignOff('Hey there,\n\nCheers for the quick reply earlier.\n\nCheers,\nOwais', FOLLOW_UP_SIGN_OFF)
  assert(inline.includes('Cheers for the quick reply earlier.'),
    'a mid-sentence "Cheers for..." is not treated as the sign-off line', JSON.stringify(inline))
}

function test2_subjectVariantsAreStableAndSpread(): void {
  console.log('\n[2] Per-lead subject variants are deterministic but spread across the pool')

  const names = [
    'Escape Hunt', 'Zero Latency', 'Sydney Motorsport Karting', 'Holey Moley',
    'Kingpin', 'Flip Out', 'Nour', 'Single O', 'Ovolo Woolloomooloo',
    'Blue Mountains Guided Tours', 'Wanderlust Travel', 'Captain Cook Cruises',
  ]

  // Stable: regenerating an email for the same lead must not silently change it.
  assert(
    names.every((n) => outreachSubjectFor(n) === outreachSubjectFor(n)),
    'outreachSubjectFor is stable for a given business name'
  )
  assert(names.every((n) => pickVariant(['a', 'b', 'c'], n, 'test') === pickVariant(['a', 'b', 'c'], n, 'test')),
    'pickVariant is stable for a given seed and salt')

  // Spread: the whole point is that the outbox isn't one template.
  const subjects = new Set(names.map(outreachSubjectFor))
  assert(subjects.size >= 4, `12 businesses produce at least 4 distinct subjects (got ${subjects.size})`)

  assert(
    !outreachSubjectFor('Test Biz').includes('!'),
    'no subject line in the pool carries an exclamation mark'
  )
}

function test3_followUpTemplates(): void {
  console.log('\n[3] Static follow-up templates are stage-distinct, self-contained and clean')

  const types: FollowUpType[] = ['follow_up_1', 'follow_up_2', 'follow_up_3']
  const built = types.map((t) => buildFollowUpEmail(t, 'Escape Hunt', 'Collab?', 'Escape Rooms', 'visit'))
  const requestedCategories = [
    'Halal Restaurants', 'Halal Cafes', 'Halal Bakeries / Dessert Shops',
    'Escape Rooms', 'VR Experiences', 'Go Karting', 'Bowling & Entertainment',
    'Mini Golf', 'Theme Parks', 'Hotels / Resorts', 'Tour Operators',
    'Travel Agents', 'Cruises', 'Beauty / Lash Studios', 'Hair Salons',
    'Nail Salons', 'Spas / Massage Studios',
  ]

  assert(new Set(built.map((b) => b.body)).size === 3, 'all three stages have distinct bodies')
  assert(built.every((b) => b.subject === 'Re: Collab?'), 'every stage threads under "Re: " + the original subject')
  assert(built.every((b) => b.body.startsWith('Hey Escape Hunt,')), 'every stage greets the business by name')
  assert(built.every((b) => b.body.endsWith(FOLLOW_UP_SIGN_OFF)), 'every stage uses the short follow-up sign-off')
  assert(
    built.every((b) => !b.body.includes('aussieventure.com')),
    'follow-ups carry no link block (they are replies in an existing thread)'
  )

  // Every follow-up must stand alone — the reader getting it is by definition
  // the one who did not engage with email one.
  assert(
    built.every((b) => /I'm Owais/.test(b.body)),
    'every stage re-introduces who is writing'
  )
  assert(
    built.every((b) => /Instagram, TikTok and Facebook/.test(b.body)),
    'every stage names where we post, so the email makes sense read cold'
  )
  assert(
    built.every((b) => /attractions and experiences/.test(b.body)),
    'the reminder is tailored to the category (Escape Rooms -> Experiences)'
  )
  assert(
    built.every((b) => !/following up|as mentioned|as I said|my last email/i.test(b.body)),
    'no stage says "following up" or otherwise assumes they read the first email'
  )

  // Floor is deliberately low: the templates must carry the reminder and the ask
  // and nothing else. A stage that comes in short is a good stage, so this only
  // guards against a stage losing the reminder entirely.
  const words = built.map((b) => b.body.split('Cheers,')[0].trim().split(/\s+/).filter(Boolean).length)
  assert(words.every((w) => w >= 35), `every stage carries enough context to stand alone (got ${words.join(', ')})`)
  assert(words.every((w) => w <= 90), `no stage exceeds the 90-word ceiling (got ${words.join(', ')})`)

  for (const [i, b] of built.entries()) {
    const hits = BANNED.filter((re) => re.test(b.body))
    assert(hits.length === 0, `${types[i]} contains no banned wording`, hits.map((r) => r.source).join(', '))
  }

  // FU2 must not open on the silence — that line belongs to FU3, and both using
  // it is the exact collision the stage rules were rewritten to prevent.
  assert(
    !/^Hey [^\n]*,\n+(I )?haven'?t heard/i.test(built[1].body),
    'FU2 does not open by mentioning the silence (FU3 owns that line)'
  )
  assert(/haven'?t heard/i.test(built[2].body), 'FU3 does mention not having heard back')

  // The purpose of each stage has to be visible in the copy.
  assert(/may not have reached you|last week/i.test(built[0].body), 'FU1 assumes the first email may have been missed')
  assert(/interested/i.test(built[0].body), 'FU1 asks whether they are interested')
  assert(/interested/i.test(built[1].body), 'FU2 checks in and asks whether they are interested')
  assert(/yes or no/i.test(built[1].body), 'FU2 makes replying easy')
  assert(/clos(e|ing)/i.test(built[2].body), 'FU3 says the enquiry is being closed')
  assert(/repl(y|ies)/i.test(built[2].body), 'FU3 says a reply reopens it')

  // FU3's opening must be first person and active — a person who checked their
  // inbox, not a system reporting a state. This is the exact wording swap the
  // stage was rewritten for.
  assert(
    /^Hey Escape Hunt,\n\nI haven'?t heard|^Hey Escape Hunt,\n\nSince I haven'?t heard/.test(built[2].body),
    'FU3 opens in the first person, actively',
    built[2].body.split('\n')[2]
  )
  assert(
    !/no reply has come through|nothing has come back|no response has been received|nothing further has been heard/i.test(built[2].body),
    'FU3 does not report the silence passively'
  )
  assert(/at my end/i.test(built[2].body), 'FU3 closes the enquiry "at my end", not "at our end"')

  // NO STAGE may mention commercials. FU1 used to offer to send package options
  // over; every stage now asks one question and stops.
  for (const [i, b] of built.entries()) {
    assert(
      !/package|pricing|price|budget|cost|rate|option|deliverable|fee/i.test(b.body),
      `${types[i]} mentions no packages, pricing, budgets or offers`
    )
    assert(
      !/happy to send|i can send|send (you )?(our|the|more|some) /i.test(b.body),
      `${types[i]} does not offer to send anything through`
    )
  }

  // The reminder names the platforms, but the pitch stays in email one.
  assert(
    built.every((b) => !/650k|followers/i.test(b.body)),
    'no follow-up restates the follower count'
  )

  for (const category of requestedCategories) {
    const sequence = types.map((type) =>
      buildFollowUpEmail(type, 'Sample Business', 'Collab?', category, 'visit')
    )
    assert(
      (sequence[0].body.match(/\?/g) ?? []).length === 1 &&
        (sequence[1].body.match(/\?/g) ?? []).length === 1 &&
        (sequence[2].body.match(/\?/g) ?? []).length === 0,
      `"${category}" follow-ups use one question in FU1/FU2 and none in FU3`
    )
    assert(
      sequence.every((email) =>
        !/package|pricing|price|budget|cost|rate|deliverable|fee|happy to send|i can send/i.test(email.body)
      ),
      `"${category}" follow-ups contain no commercial wording`
    )
  }
}

function test4_outreachPromptContract(): void {
  console.log('\n[4] The initial-email prompt pins down the things it must')

  const params = {
    business_name: 'Escape Hunt',
    category: 'Escape Rooms',
    suburb: 'Surry Hills',
    city: 'Sydney',
    description: 'Themed escape rooms with four rooms running.',
    services: 'Bookings for groups of 2-8',
  }
  const prompt = buildOutreachEmailPrompt(params, 'visit')
  const fullInitialInstructions = `${OUTREACH_EMAIL_SYSTEM_PROMPT}\n${prompt}`

  assert(prompt.includes(params.description), 'the business description reaches the prompt')
  assert(prompt.includes(params.services), 'the business services reach the prompt')
  assert(prompt.includes('Escape Rooms'), 'the raw category name reaches the prompt')
  assert(prompt.includes(`"${outreachSubjectFor(params.business_name)}"`),
    'the prompt pins the exact subject line chosen for this lead')
  assert(prompt.includes(INITIAL_SIGN_OFF), 'the canonical initial sign-off is in the prompt')
  assert(fullInitialInstructions.includes('70 to 120 words'), 'the requested 70-120 word range is stated')
  assert(/silently recount before returning/i.test(prompt), 'the prompt enforces the word-count check')
  assert(prompt.includes(`Start with exactly "Hey ${params.business_name},"`), 'the personalised greeting is fixed')
  assert(/Sydney/.test(prompt), 'visit leads get the Sydney framing')

  assert(/at most one supplied Description or Services detail/.test(prompt), 'research is limited to one meaningful detail')
  assert(/Paraphrase it/.test(prompt), 'scraped facts must be rewritten naturally')
  assert(/do not default to biography first/i.test(OUTREACH_EMAIL_SYSTEM_PROMPT),
    'the model is explicitly told to vary its opening')
  assert(!/WRITE FOUR PARTS, IN THIS ORDER/.test(prompt),
    'the old fixed four-part template has been removed')
  assert(/ASSIGNMENT FOR THIS RECIPIENT/.test(prompt),
    'each isolated generation receives a per-business structural direction')
  assert(/silently confirm/.test(OUTREACH_EMAIL_SYSTEM_PROMPT), 'the prompt includes a self-review pass')
  assert(/Return one final JSON object and nothing else/.test(OUTREACH_EMAIL_SYSTEM_PROMPT),
    'the prompt forbids visible drafts that break JSON parsing')
  assert(/NON-NEGOTIABLE PRIORITIES/.test(OUTREACH_EMAIL_SYSTEM_PROMPT),
    'voice and output rules use the provider system channel')
  assert(/Never show analysis, a discarded draft or a revision/.test(OUTREACH_EMAIL_SYSTEM_PROMPT),
    'the system prompt prevents visible self-review from exhausting the output budget')

  for (const phrase of [
    'you came up', 'yours came up', "thought I'd ask", "thought I'd reach out",
    "which is why I'm emailing", 'at the moment', "I haven't covered much",
    'asking a few places directly', "we're covering", "I'm covering", "we're doing more",
  ]) {
    assert(fullInitialInstructions.includes(phrase), `the initial prompt strongly avoids "${phrase}"`)
  }

  // The remote framing can state the true Sydney base, but must never move Owais
  // to the recipient's city or imply he is local to them.
  const remote = `${OUTREACH_EMAIL_SYSTEM_PROMPT}\n${buildOutreachEmailPrompt({ ...params, city: 'Perth', suburb: 'Fremantle' }, 'remote')}`
  assert(
    /never relocate him to the recipient's city/.test(remote) &&
      !/Owais is based in (Perth|Fremantle)/.test(remote),
    'remote leads cannot be told Owais is local to them'
  )

  // The prompt must forbid the things that suppress replies.
  for (const rule of ['Do not sell', 'is a fit', 'em dash', 'agency', 'AI']) {
    assert(fullInitialInstructions.toLowerCase().includes(rule.toLowerCase()), `prompt covers "${rule}"`)
  }

  // A lead with no scraped facts must be told not to invent one.
  const noFacts = buildOutreachEmailPrompt(
    { ...params, description: undefined, services: undefined },
    'remote'
  )
  assert(
    /Do not manufacture personalisation/.test(noFacts),
    'with no Description/Services facts, the prompt forbids fake personalisation'
  )
}

function test5_categoryReminder(): void {
  console.log('\n[5] The reminder sentence is derived from the category, not hardcoded')

  // The two wordings the brief names explicitly.
  assert(
    brandReminderOptions('Halal Restaurants')[0] ===
      "I'm Owais from Aussie Venture. We create halal food content across Instagram, TikTok and Facebook.",
    'Restaurants get the food reminder'
  )
  assert(
    brandReminderOptions('Escape Rooms')[0] ===
      "I'm Owais from Aussie Venture. We create content featuring attractions and experiences across Instagram, TikTok and Facebook.",
    'Escape Rooms get the experiences reminder'
  )

  // Every seeded category resolves to one of the four fallback families.
  const seeded: [string, string][] = [
    ['Halal Restaurants', 'Food'], ['Halal Cafes', 'Food'], ['Halal Bakeries / Dessert Shops', 'Food'],
    ['Nail Salons', 'Lifestyle'], ['Hair Salons', 'Lifestyle'], ['Beauty / Lash Studios', 'Lifestyle'],
    ['Spas / Massage Studios', 'Lifestyle'], ['Travel Agents', 'Travel'], ['Tour Operators', 'Travel'],
    ['Hotels / Resorts', 'Travel'],
    // The activity categories used across the docs and import template.
    ['Escape Rooms', 'Experiences'], ['VR Experiences', 'Experiences'], ['Go Karting', 'Experiences'],
    ['Mini Golf', 'Experiences'], ['Bowling', 'Experiences'], ['Theme Parks', 'Experiences'],
    ['Trampoline Parks', 'Experiences'], ['Cruises', 'Experiences'],
  ]
  for (const [category, family] of seeded) {
    assert(getReminderFamily(category) === family, `"${category}" -> ${family}`, getReminderFamily(category))
  }

  // Categories nobody has added yet must still produce a sensible sentence.
  // The last one is the safety net: a name matching no keyword at all lands on
  // Lifestyle, which is true of Aussie Venture regardless of what the business is.
  const unseen: [string, string][] = [
    ['Pet Grooming', 'Lifestyle'],
    ['Serviced Apartments', 'Travel'],
    ['Axe Throwing', 'Experiences'],
    ['Ramen Restaurants', 'Food'],
    ['Something Nobody Has Thought Of', 'Lifestyle'],
  ]
  for (const [category, family] of unseen) {
    assert(getReminderFamily(category) === family, `unseen "${category}" falls back to ${family}`, getReminderFamily(category))
  }
  assert(
    unseen.every(([c]) => /^I'm Owais.*Instagram, TikTok and Facebook\.$/.test(brandReminderOptions(c)[0])),
    'an unseen category still produces a well-formed reminder sentence'
  )

  // One sentence, always. The reminder is not allowed to grow into a pitch.
  const allCategories = [...seeded, ...unseen].map(([c]) => c)
  for (const c of allCategories) {
    const bad = brandReminderOptions(c).filter(
      (s) => (s.match(/\./g) ?? []).length !== 2 || /650k|followers/i.test(s)
    )
    assert(bad.length === 0, `"${c}" reminders stay two short sentences with no follower count`, bad[0])
  }

  // Rephrased down the thread rather than pasted three times.
  const perStage = new Set(['fu1', 'fu2', 'fu3'].map((s) => reminderFor('Escape Rooms', 'Escape Hunt', s)))
  assert(perStage.size > 1, 'the reminder is rephrased across stages, not repeated verbatim', `${perStage.size}`)
  assert(
    reminderFor('Escape Rooms', 'Escape Hunt', 'fu1') === reminderFor('Escape Rooms', 'Escape Hunt', 'fu1'),
    'the reminder is stable for a given lead and stage'
  )
}

function test6_followUpPromptContract(): void {
  console.log('\n[6] Every follow-up prompt demands a self-contained email')

  const params = {
    business_name: 'Escape Hunt',
    category: 'Escape Rooms',
    suburb: 'Surry Hills',
    city: 'Sydney',
    website: 'escapehunt.com',
    description: 'Themed escape rooms with four rooms running.',
    services: 'Bookings for groups of 2-8',
    notes: '',
  }
  const history = [{ type: 'initial_pitch', subject: 'Collab?', body: 'Hey Escape Hunt,\n\nFirst email.' }]

  for (const n of [1, 2, 3] as const) {
    const prompt = buildFollowUpEmailPrompt(params, n, history)
    assert(prompt.includes(reminderFor(params.category, params.business_name, `fu${n}`)),
      `FU${n} prompt pins the exact category reminder for this lead`)
    assert(/THE REMINDER/.test(prompt), `FU${n} prompt marks the reminder as a required part`)
    assert(/THIS EMAIL MUST STAND ALONE/.test(prompt), `FU${n} prompt requires the email to stand alone`)
    assert(/just following up/i.test(prompt), `FU${n} prompt bans "just following up"`)
    assert(prompt.includes(FOLLOW_UP_SIGN_OFF), `FU${n} prompt carries the short follow-up sign-off`)
    assert(prompt.includes('Themed escape rooms'), `FU${n} prompt still receives the business facts as background`)

    // The commercials ban now applies to all three stages, not just FU2.
    assert(prompt.includes(NO_COMMERCIALS_RULE), `FU${n} prompt forbids packages, pricing, budgets and offers`)
    assert(/Do not offer to send anything through/.test(prompt), `FU${n} prompt forbids offering to send options over`)

    // The word band must not be readable as a target to pad towards.
    assert(prompt.includes(LENGTH_RULE), `FU${n} prompt states the band is a ceiling, not a target`)
    assert(/Never add a sentence to reach a word count/.test(prompt), `FU${n} prompt bans padding`)
  }

  // Stage-specific jobs.
  const fu1 = buildFollowUpEmailPrompt(params, 1, history)
  const fu2 = buildFollowUpEmailPrompt(params, 2, history)
  const fu3 = buildFollowUpEmailPrompt(params, 3, history)

  assert(/ASSUME THEY NEVER SAW THE FIRST EMAIL/.test(fu1), 'FU1 assumes the first email was missed')
  assert(
    !/package/i.test(fu1.split(VOICE_RULES)[0]),
    'FU1 stage guidance no longer offers to send package options'
  )
  assert(/check in once more/.test(fu2), 'FU2 is framed as a check-in')
  assert(/close the loop/.test(fu3), 'FU3 closes the enquiry')
  assert(/It still carries the reminder/.test(fu3), 'FU3 keeps the reminder while closing')

  // FU3's opening line is pinned, first person and active. The passive version is
  // what the model reaches for unprompted, so it is banned by name.
  assert(
    FU3_CLOSING_LINES.some((l) => fu3.includes(`"${l}"`)),
    'FU3 prompt pins one exact first-person closing line'
  )
  assert(
    /no reply has come through/i.test(fu3),
    'FU3 prompt names the passive phrasing it is banning'
  )
  assert(
    FU3_CLOSING_LINES.every((l) => /at my end/.test(l) && /^(I|Since I) haven'?t heard/.test(l)),
    'every FU3 closing line is first person, active, and closes at "my end"'
  )

  // Word bands must sit under the 90-word ceiling and must not have a floor high
  // enough to make padding the easiest way to comply.
  for (const [n, prompt] of [[1, fu1], [2, fu2], [3, fu3]] as const) {
    const band = prompt.match(/(\d+) to (\d+) words before the sign-off/)
    assert(band !== null && Number(band[2]) <= 90, `FU${n} states a word band inside the 90-word ceiling`, band?.[0])
    assert(band !== null && Number(band[1]) <= 45, `FU${n}'s word floor is low enough not to invite padding`, band?.[0])
  }
}

function test7_reactivationPromptContract(): void {
  console.log('\n[7] The reactivation email is a re-introduction, not a cold email')

  const params = {
    business_name: 'Al Aseel',
    category: 'Halal Restaurants',
    suburb: 'Lakemba',
    city: 'Sydney',
  }
  const prompt = buildReactivationEmailPrompt(params, 'visit')

  assert(/fresh introduction/.test(prompt), 'it is briefed as a fresh introduction')
  assert(/Assume they remember nothing/.test(prompt), 'it assumes they remember nothing')
  assert(
    /You emailed this business a few months ago/.test(prompt),
    'it acknowledges the earlier outreach rather than pretending it never happened'
  )
  assert(
    /Do not pretend you have never emailed them/.test(prompt),
    'it explicitly forbids pretending this is a first contact'
  )
  assert(/It is about TIMING/.test(prompt), 'the ask is about timing, not about the collab again')
  assert(
    REACTIVATION_ASKS.some((a) => prompt.includes(`"${a}"`)),
    'the prompt pins one exact timing ask'
  )

  // Fresh send, so a fresh subject and the full sign-off with links.
  const subject = reactivationSubjectFor(params.business_name)
  assert(prompt.includes(`"${subject}"`), 'the prompt pins the exact reactivation subject')
  assert(!subject.startsWith('Re:'), 'the reactivation subject is not a "Re:" of the dead thread')
  assert(prompt.includes(INITIAL_SIGN_OFF), 'it uses the full sign-off, so a stranger can go and check who we are')

  // The voice layer applies here too — this used to be the one prompt that
  // hand-rolled its own rules and drifted from the rest of the sequence.
  for (const rule of ['DO NOT SELL', 'BANNED WORDING', 'VOICE', 'em dash']) {
    assert(prompt.toLowerCase().includes(rule.toLowerCase()), `prompt covers "${rule}"`)
  }
  assert(/65 to 100 words/.test(prompt), 'the word band is stated and sits inside the sequence ceiling')
  assert(prompt.includes(LENGTH_RULE), 'the band is stated as a ceiling, not a target to pad towards')
  assert(
    /No guilt, no pressure, no urgency/.test(prompt),
    'the hard limits rule out guilt, pressure and urgency'
  )

  // The reactivation email must not describe the reader in internal vocabulary.
  // "another round of Sydney halal dining spots" was both a campaign phrase and a
  // taxonomy label in one sentence.
  // Checked against the instructions only, not the whole prompt: BANNED_WORDING
  // has to quote these phrases in order to ban them.
  const instructions = prompt.split('BANNED WORDING')[0]
  assert(
    !/another round of|a fresh round of|the next batch of/i.test(instructions),
    'the prompt never frames this as another round or batch'
  )
  assert(
    !/dining spots|lifestyle venues|activities and attractions/i.test(prompt),
    'the internal category labels are gone from the copy'
  )
  assert(
    REACTIVATION_ASKS.some((a) => prompt.includes(`"${a}"`)) &&
      reactivationContextOptions(getReactivationFocus(params.category, 'visit')).some((c) => prompt.includes(`"${c}"`)),
    'the prompt pins one conversational sentence for why you are writing now'
  )
  assert(
    /restaurants around Sydney/.test(prompt),
    'a Sydney halal restaurant is described as "restaurants around Sydney", not as a dining spot',
    getReactivationFocus(params.category, 'visit')
  )

  // Remote leads must not be told we are local to them.
  const remote = buildReactivationEmailPrompt({ ...params, city: 'Perth', suburb: 'Fremantle' }, 'remote')
  assert(
    !/based in Sydney/.test(remote.split('HARD LIMITS')[0]),
    'remote reactivation leads are not told we are based in Sydney'
  )

  // A different category must move the content wording with it.
  const activity = buildReactivationEmailPrompt(
    { business_name: 'Escape Hunt', category: 'Escape Rooms', suburb: 'Surry Hills', city: 'Sydney' },
    'visit'
  )
  assert(/things to do around Sydney/.test(activity), 'the reactivation content focus follows the category')
  assert(
    getReactivationFocus('Theme Parks', 'visit') === 'days out around Sydney',
    'Theme Parks get natural visit wording',
    getReactivationFocus('Theme Parks', 'visit')
  )

  // Remote leads get "around Australia", never the adjective "Australian
  // restaurants", which reads as cuisine rather than location.
  const remoteFocus = getReactivationFocus('Halal Restaurants', 'remote')
  assert(remoteFocus === 'halal restaurants around Australia', 'remote leads get "around Australia"', remoteFocus)
  assert(
    !/^Australian |^Sydney /.test(getReactivationFocus('Hotels / Resorts', 'remote')),
    'the focus phrase never opens with the location adjective',
    getReactivationFocus('Hotels / Resorts', 'remote')
  )
}

function main(): void {
  console.log('═'.repeat(62))
  console.log('  TEST:EMAIL-VOICE — pure logic, no network')
  console.log('═'.repeat(62))

  test1_enforceSignOff()
  test2_subjectVariantsAreStableAndSpread()
  test3_followUpTemplates()
  test4_outreachPromptContract()
  test5_categoryReminder()
  test6_followUpPromptContract()
  test7_reactivationPromptContract()

  console.log('\n' + '═'.repeat(62))
  if (failures === 0) {
    console.log('  ✓ ALL CHECKS PASSED')
    console.log('═'.repeat(62))
    process.exit(0)
  } else {
    console.log(`  ✗ ${failures} CHECK(S) FAILED`)
    console.log('═'.repeat(62))
    process.exit(1)
  }
}

main()
