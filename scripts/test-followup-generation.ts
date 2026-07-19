/**
 * scripts/test-followup-generation.ts
 *
 * Pure-logic tests for the Claude-generated FU1/FU2/FU3 follow-up content
 * (src/lib/followup-generation.ts, src/lib/claude.ts's writeFollowUpEmail).
 * No DB, no network calls — the AI call is stubbed via generateFollowUpEmail's
 * injectable `aiGenerator` parameter, so behaviour (history passing, stage
 * selection, fallback-on-failure) is fully deterministic and doesn't need a
 * live ANTHROPIC_API_KEY.
 *
 * Run: npm run test:followup-generation
 */

import * as fs from 'fs'
import * as path from 'path'
import {
  generateFollowUpEmail,
  type FollowUpAiGenerator,
  type FollowUpBusinessContext,
  type FollowUpThreadEmail,
} from '@/lib/followup-generation'
import { buildFollowUpEmailPrompt } from '@/lib/claude'
import { buildFollowUpEmail } from '@/lib/followup-email-templates'
import { computeFollowUpEligibility, type FollowUpType } from '@/lib/followup-eligibility'

let failures = 0

function assert(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  ✓ ${message}`)
  } else {
    console.log(`  ✗ ${message}`)
    failures++
  }
}

const BUSINESS: FollowUpBusinessContext = {
  businessName: 'Escape Hunt',
  category:     'Escape Rooms',
  suburb:       'Surry Hills',
  city:         'Sydney',
  website:      'https://escapehunt.example',
  description:  'A themed escape room venue with multiple immersive puzzle rooms.',
  services:     'Escape room bookings for groups of 2-8',
  notes:        'Owner mentioned they run a Halloween-themed room seasonally.',
  contentType:  'visit',
}

const INITIAL_SUBJECT = 'Collab with Aussie Venture - Escape Hunt'

const THREAD_SO_FAR: FollowUpThreadEmail[] = [
  { type: 'initial_pitch', subject: INITIAL_SUBJECT, body: 'Hey Escape Hunt, I run Aussie Venture...' },
]

async function test1_sameGeneratorForImportedAndNormalLeads(): Promise<void> {
  console.log('\n[1] Imported leads and normal leads call the same generator')

  const followupAgentSrc = fs.readFileSync(path.resolve(process.cwd(), 'agents/followup.ts'), 'utf8')
  const leadsRouteSrc    = fs.readFileSync(path.resolve(process.cwd(), 'src/app/api/leads/route.ts'), 'utf8')

  assert(
    /from ['"]@\/lib\/followup-generation['"]/.test(followupAgentSrc) && /generateFollowUpEmail\(/.test(followupAgentSrc),
    'agents/followup.ts (live daily sender) imports and calls generateFollowUpEmail'
  )
  assert(
    /from ['"]@\/lib\/followup-generation['"]/.test(leadsRouteSrc) && /generateFollowUpEmail\(/.test(leadsRouteSrc),
    'src/app/api/leads/route.ts (staged-lead import backfill) imports and calls generateFollowUpEmail'
  )
  assert(
    !/buildFollowUpEmail\(/.test(followupAgentSrc.replace(/\/\/.*$/gm, '')),
    'agents/followup.ts no longer calls the static template directly (only generateFollowUpEmail, which falls back internally)'
  )
}

async function test2_historyReachesPrompt(): Promise<void> {
  console.log('\n[2] Previous email history reaches the Claude prompt')

  const history: FollowUpThreadEmail[] = [
    { type: 'initial_pitch', subject: INITIAL_SUBJECT, body: 'INITIAL_BODY_MARKER_12345' },
    { type: 'follow_up_1', subject: `Re: ${INITIAL_SUBJECT}`, body: 'FU1_BODY_MARKER_67890' },
  ]

  const prompt = buildFollowUpEmailPrompt(
    {
      business_name: BUSINESS.businessName,
      category:      BUSINESS.category,
      suburb:        BUSINESS.suburb,
      city:          BUSINESS.city,
      website:       BUSINESS.website,
      description:   BUSINESS.description,
      services:      BUSINESS.services,
      notes:         BUSINESS.notes,
    },
    2,
    history,
    'a Sydney-based lifestyle platform'
  )

  assert(prompt.includes('INITIAL_BODY_MARKER_12345'), 'prompt includes the initial pitch body')
  assert(prompt.includes('FU1_BODY_MARKER_67890'), 'prompt includes the follow_up_1 body')
  assert(prompt.includes(BUSINESS.description), 'prompt includes the business description')
  assert(prompt.includes(BUSINESS.services), 'prompt includes the business services')
  assert(prompt.includes(BUSINESS.notes), 'prompt includes lead notes')
  assert(prompt.includes('Escape Rooms'), 'prompt includes the raw category name (not just a generic noun)')

  let captured: FollowUpThreadEmail[] | null = null
  const capturingGenerator: FollowUpAiGenerator = async (params) => {
    captured = params.history
    return { subject: `Re: ${params.initial_subject}`, body: 'A short, relevant follow-up body.' }
  }

  await generateFollowUpEmail('follow_up_2', BUSINESS, INITIAL_SUBJECT, history, capturingGenerator)
  assert(JSON.stringify(captured) === JSON.stringify(history), 'generateFollowUpEmail forwards the exact history array to the AI generator')
}

async function test3_correctStageGenerated(): Promise<void> {
  console.log('\n[3] Correct follow-up stage/number is generated')

  for (const [type, expectedNumber] of [['follow_up_1', 1], ['follow_up_2', 2], ['follow_up_3', 3]] as const) {
    let seenNumber: number | null = null
    const generator: FollowUpAiGenerator = async (params) => {
      seenNumber = params.follow_up_number
      return { subject: `Re: ${params.initial_subject}`, body: 'ok' }
    }
    const result = await generateFollowUpEmail(type, BUSINESS, INITIAL_SUBJECT, THREAD_SO_FAR, generator)
    assert(seenNumber === expectedNumber, `${type} → follow_up_number ${expectedNumber} passed to the AI generator`)
    assert(result.subject === `Re: ${INITIAL_SUBJECT}`, `${type} → subject stays "Re: ${INITIAL_SUBJECT}" (thread continuity)`)
  }

  // Fallback content must also be stage-correct, not just AI content.
  const failingGenerator: FollowUpAiGenerator = async () => { throw new Error('forced failure') }
  for (const type of ['follow_up_1', 'follow_up_2', 'follow_up_3'] as FollowUpType[]) {
    const result = await generateFollowUpEmail(type, BUSINESS, INITIAL_SUBJECT, THREAD_SO_FAR, failingGenerator)
    const expectedTemplate = buildFollowUpEmail(type, BUSINESS.businessName, INITIAL_SUBJECT, BUSINESS.category, BUSINESS.contentType)
    assert(result.body === expectedTemplate.body, `${type} fallback body matches the ${type}-specific static template (not a different stage's copy)`)
  }
}

async function test4_fallbackOnAiFailure(): Promise<void> {
  console.log('\n[4] Fallback to static template when Claude generation fails')

  const throwingGenerator: FollowUpAiGenerator = async () => {
    throw new Error('simulated Claude API failure')
  }
  const result = await generateFollowUpEmail('follow_up_1', BUSINESS, INITIAL_SUBJECT, THREAD_SO_FAR, throwingGenerator)
  const expectedTemplate = buildFollowUpEmail('follow_up_1', BUSINESS.businessName, INITIAL_SUBJECT, BUSINESS.category, BUSINESS.contentType)

  assert(result.source === 'template', 'source is "template" when the AI generator throws')
  assert(result.subject === expectedTemplate.subject, 'fallback subject matches the static template')
  assert(result.body === expectedTemplate.body, 'fallback body matches the static template exactly')
  assert(result.html === expectedTemplate.html, 'fallback html matches the static template exactly')

  // Malformed AI output (empty body) must also trigger fallback, not a broken send —
  // mirrors writeFollowUpEmail's real contract of throwing on an empty/missing body.
  const throwsOnEmpty: FollowUpAiGenerator = async (params) => {
    const body = ''
    if (!body.trim()) throw new Error('no usable body')
    return { subject: `Re: ${params.initial_subject}`, body }
  }
  const result2 = await generateFollowUpEmail('follow_up_2', BUSINESS, INITIAL_SUBJECT, THREAD_SO_FAR, throwsOnEmpty)
  assert(result2.source === 'template', 'malformed/empty AI response also falls back to the static template')

  // The pipeline must keep going — generateFollowUpEmail never rethrows.
  let threwAtCallSite = false
  try {
    await generateFollowUpEmail('follow_up_3', BUSINESS, INITIAL_SUBJECT, THREAD_SO_FAR, throwingGenerator)
  } catch {
    threwAtCallSite = true
  }
  assert(!threwAtCallSite, 'generateFollowUpEmail never throws — daily pipeline continues even when Claude is down')
}

async function test5_neverSentTwice(): Promise<void> {
  console.log('\n[5] No follow-up stage is ever selected twice')

  const SETTINGS = { fu1Days: 7, fu2Days: 14, fu3Days: 21 }
  const initialSentAt = new Date(Date.now() - 30 * 86_400_000).toISOString() // 30 days ago — all 3 FUs are overdue

  const sentFlags = { fu1: false, fu2: false, fu3: false }
  const selections: FollowUpType[] = []

  // Simulate 5 consecutive daily-pipeline passes. Each pass sends at most the
  // one FU the eligibility engine currently nominates, then marks it sent —
  // mirroring how agents/followup.ts flips emails.sent_at after a real send.
  for (let pass = 0; pass < 5; pass++) {
    const eligibility = computeFollowUpEligibility(
      initialSentAt, sentFlags.fu1, sentFlags.fu2, sentFlags.fu3, SETTINGS, new Date()
    )
    if (eligibility.nextFuType === null || !eligibility.isDue) continue
    selections.push(eligibility.nextFuType)
    if (eligibility.nextFuType === 'follow_up_1') sentFlags.fu1 = true
    else if (eligibility.nextFuType === 'follow_up_2') sentFlags.fu2 = true
    else sentFlags.fu3 = true
  }

  assert(selections.length === 3, `exactly 3 follow-ups selected across 5 passes (got: ${selections.join(', ')})`)
  assert(new Set(selections).size === selections.length, 'every selected stage is distinct — no stage nominated twice')
  assert(
    selections.join(',') === 'follow_up_1,follow_up_2,follow_up_3',
    'stages selected in order FU1 → FU2 → FU3'
  )

  // A 6th pass, after all three are sent, must select nothing.
  const finalEligibility = computeFollowUpEligibility(initialSentAt, true, true, true, SETTINGS, new Date())
  assert(finalEligibility.nextFuType === null, 'once all 3 follow-ups are sent, no further stage is ever nominated again')
}

async function main(): Promise<void> {
  console.log('═'.repeat(62))
  console.log('  TEST:FOLLOWUP-GENERATION — pure logic, stubbed AI, no network')
  console.log('═'.repeat(62))

  await test1_sameGeneratorForImportedAndNormalLeads()
  await test2_historyReachesPrompt()
  await test3_correctStageGenerated()
  await test4_fallbackOnAiFailure()
  await test5_neverSentTwice()

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

main().catch((err) => {
  console.error('Fatal:', err instanceof Error ? err.message : err)
  process.exit(1)
})
