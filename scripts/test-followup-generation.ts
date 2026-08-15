/**
 * Pure-logic coverage for template-only FU1/FU2/FU3 generation.
 *
 * No DB, network, or AI provider calls. The legacy injectable generator parameter is
 * still passed to prove the public interface remains compatible, but invoking it
 * is a test failure.
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
import { buildFollowUpEmail } from '@/lib/followup-email-templates'
import { computeFollowUpEligibility, type FollowUpType } from '@/lib/followup-eligibility'
import { composeOutreachEmailBody } from '@/lib/outreach-signature'

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
  category: 'Escape Rooms',
  suburb: 'Surry Hills',
  city: 'Sydney',
  website: 'https://escapehunt.example',
  description: 'A themed escape room venue with multiple immersive puzzle rooms.',
  services: 'Escape room bookings for groups of 2-8',
  notes: 'Owner mentioned they run a Halloween-themed room seasonally.',
  contentType: 'visit',
}

const INITIAL_SUBJECT = 'Collab with Aussie Venture - Escape Hunt'
const THREAD_SO_FAR: FollowUpThreadEmail[] = [
  { type: 'initial_pitch', subject: INITIAL_SUBJECT, body: 'Hey Escape Hunt, I run Aussie Venture...' },
]

async function testSharedGeneratorCallers(): Promise<void> {
  console.log('\n[1] Imported, scheduled, and resent follow-ups use the shared generator')

  const followupAgentSrc = fs.readFileSync(path.resolve(process.cwd(), 'agents/followup.ts'), 'utf8')
  const createLeadSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/lib/create-lead.ts'), 'utf8')
  const resendRouteSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/app/api/leads/[id]/resend/route.ts'), 'utf8')

  assert(
    /from ['"]@\/lib\/followup-generation['"]/.test(followupAgentSrc) && /generateFollowUpEmail\(/.test(followupAgentSrc),
    'daily follow-up agent still calls generateFollowUpEmail'
  )
  assert(
    /from ['"]@\/lib\/followup-generation['"]/.test(createLeadSrc) && /generateFollowUpEmail\(/.test(createLeadSrc),
    'staged import backfill still calls generateFollowUpEmail'
  )
  assert(
    /from ['"]@\/lib\/followup-generation['"]/.test(resendRouteSrc) && /generateFollowUpEmail\(/.test(resendRouteSrc),
    'resend endpoint still calls generateFollowUpEmail'
  )
}

async function testTemplatesReturnedDirectly(): Promise<void> {
  console.log('\n[2] Every follow-up stage returns the existing template directly')

  let aiCalls = 0
  const forbiddenGenerator: FollowUpAiGenerator = async () => {
    aiCalls++
    throw new Error('AI generator must never be called')
  }

  for (const type of ['follow_up_1', 'follow_up_2', 'follow_up_3'] as FollowUpType[]) {
    const result = await generateFollowUpEmail(
      type,
      BUSINESS,
      INITIAL_SUBJECT,
      THREAD_SO_FAR,
      forbiddenGenerator
    )
    const expected = buildFollowUpEmail(
      type,
      BUSINESS.businessName,
      INITIAL_SUBJECT,
      BUSINESS.category,
      BUSINESS.contentType
    )

    assert(result.source === 'template', `${type} reports template source`)
    assert(result.subject === expected.subject, `${type} subject exactly matches buildFollowUpEmail`)
    const composed = composeOutreachEmailBody(expected.body)
    assert(result.body === composed.bodyText, `${type} preserves template copy and adds the canonical signature`)
    assert(result.html === composed.bodyHtml, `${type} HTML matches the shared outreach composer`)
  }

  assert(aiCalls === 0, 'the legacy AI generator parameter is never invoked')
}

async function testNoFollowUpAiWriter(): Promise<void> {
  console.log('\n[3] AI follow-up writer is removed')

  const aiSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/ai/email-generation.ts'), 'utf8')
  const generationSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/lib/followup-generation.ts'), 'utf8')

  assert(!/export async function writeFollowUpEmail\(/.test(aiSrc), 'writeFollowUpEmail is no longer exported')
  assert(!/aiRegistry\.generate\(/.test(generationSrc), 'generateFollowUpEmail contains no AI provider call')
  assert(/buildFollowUpEmail\(/.test(generationSrc), 'generateFollowUpEmail calls buildFollowUpEmail directly')
}

async function testNeverSentTwice(): Promise<void> {
  console.log('\n[4] No follow-up stage is ever selected twice')

  const settings = { fu1Days: 7, fu2Days: 14, fu3Days: 21 }
  const initialSentAt = new Date(Date.now() - 30 * 86_400_000).toISOString()
  const sentFlags = { fu1: false, fu2: false, fu3: false }
  const selections: FollowUpType[] = []

  for (let pass = 0; pass < 5; pass++) {
    const eligibility = computeFollowUpEligibility(
      initialSentAt,
      sentFlags.fu1,
      sentFlags.fu2,
      sentFlags.fu3,
      settings,
      new Date()
    )
    if (eligibility.nextFuType === null || !eligibility.isDue) continue
    selections.push(eligibility.nextFuType)
    if (eligibility.nextFuType === 'follow_up_1') sentFlags.fu1 = true
    else if (eligibility.nextFuType === 'follow_up_2') sentFlags.fu2 = true
    else sentFlags.fu3 = true
  }

  assert(selections.join(',') === 'follow_up_1,follow_up_2,follow_up_3', 'stages remain selected once, in order')
  const finalEligibility = computeFollowUpEligibility(initialSentAt, true, true, true, settings, new Date())
  assert(finalEligibility.nextFuType === null, 'all three sent means no further stage is selected')
}

async function main(): Promise<void> {
  console.log('═'.repeat(62))
  console.log('  TEST:FOLLOWUP-GENERATION — template-only, no network')
  console.log('═'.repeat(62))

  await testSharedGeneratorCallers()
  await testTemplatesReturnedDirectly()
  await testNoFollowUpAiWriter()
  await testNeverSentTwice()

  console.log('\n' + '═'.repeat(62))
  if (failures === 0) {
    console.log('  ✓ ALL CHECKS PASSED')
    console.log('═'.repeat(62))
    process.exit(0)
  }

  console.log(`  ✗ ${failures} CHECK(S) FAILED`)
  console.log('═'.repeat(62))
  process.exit(1)
}

main().catch((err) => {
  console.error('Fatal:', err instanceof Error ? err.message : err)
  process.exit(1)
})
