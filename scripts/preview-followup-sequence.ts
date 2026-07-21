/**
 * scripts/preview-followup-sequence.ts
 *
 * Live preview of a full outreach sequence (Initial + FU1 + FU2 + FU3) for one
 * sample business, using real Claude calls via the same functions production
 * uses (writeOutreachEmail / generateFollowUpEmail), so the output reflects
 * exactly what the live pipeline would send.
 *
 * No DB access needed — business facts are hardcoded below.
 *
 * Run: npx tsx scripts/preview-followup-sequence.ts
 */

import * as dotenv from 'dotenv'
import * as path from 'path'
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') })

import type { FollowUpThreadEmail } from '@/lib/followup-generation'

const BUSINESS = {
  business_name: 'Salty Fox Cafe',
  category: 'Cafe',
  suburb: 'Manly',
  city: 'Sydney',
  website: 'https://saltyfoxcafe.example',
  description: 'A beachside cafe known for its all-day breakfast menu and house-made sourdough, with an outdoor courtyard overlooking the beach.',
  services: 'Breakfast and lunch dining, specialty coffee, sourdough bread sales, weekend brunch bookings for groups',
  notes: '',
  content_type: 'visit',
}

async function main() {
  const { writeOutreachEmail } = await import('@/lib/claude')
  const { generateFollowUpEmail } = await import('@/lib/followup-generation')

  console.log('═'.repeat(70))
  console.log(`SAMPLE SEQUENCE — ${BUSINESS.business_name}`)
  console.log('═'.repeat(70))

  const initial = await writeOutreachEmail(BUSINESS)
  console.log('\n--- INITIAL OUTREACH ---')
  console.log('Subject:', initial.subject)
  console.log('\n' + initial.body)

  const history: FollowUpThreadEmail[] = [
    { type: 'initial_pitch', subject: initial.subject, body: initial.body },
  ]

  const businessContext = {
    businessName: BUSINESS.business_name,
    category: BUSINESS.category,
    suburb: BUSINESS.suburb,
    city: BUSINESS.city,
    website: BUSINESS.website,
    description: BUSINESS.description,
    services: BUSINESS.services,
    notes: BUSINESS.notes,
    contentType: BUSINESS.content_type,
  }

  for (const type of ['follow_up_1', 'follow_up_2', 'follow_up_3'] as const) {
    const fu = await generateFollowUpEmail(type, businessContext, initial.subject, history)
    console.log(`\n--- ${type.toUpperCase()} --- (source: ${fu.source})`)
    console.log('Subject:', fu.subject)
    console.log('\n' + fu.body)
    history.push({ type, subject: fu.subject, body: fu.body })
  }

  console.log('\n' + '═'.repeat(70))
  console.log('DONE')
}

main().catch((err) => {
  console.error('Fatal:', err instanceof Error ? err.message : err)
  process.exit(1)
})
