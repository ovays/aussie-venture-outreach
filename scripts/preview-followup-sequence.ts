/**
 * Preview FU1/FU2/FU3 for every ReachAgent category using the exact production
 * generation functions.
 *
 * No DB access is needed. Run with:
 *   npx tsx scripts/preview-followup-sequence.ts
 */

import * as dotenv from 'dotenv'
import * as path from 'path'

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') })

import type { FollowUpThreadEmail } from '@/lib/followup-generation'

const SAMPLE_BUSINESSES = [
  { category: 'Restaurant', business_name: 'Student Biryani' },
  { category: 'Cafe', business_name: 'Salty Fox Cafe' },
  { category: 'Bakery', business_name: 'Seemi Fusion Cakes' },
  { category: 'Escape Rooms', business_name: 'Escape Hunt Sydney' },
  { category: 'VR Experiences', business_name: 'Entermission Sydney' },
  { category: 'Go Karts', business_name: 'Hyper Karting' },
  { category: 'Bowling', business_name: 'Zone Bowling' },
  { category: 'Mini Golf', business_name: 'Holey Moley' },
  { category: 'Theme Parks', business_name: 'Luna Park Sydney' },
  { category: 'Hotel', business_name: 'Crowne Plaza Sydney' },
  { category: 'Tour Operators', business_name: "Anderson's Tours" },
  { category: 'Travel Agents', business_name: 'Flight Centre' },
  { category: 'Cruises', business_name: 'Captain Cook Cruises' },
  { category: 'Beauty', business_name: 'The Beauty Bar' },
  { category: 'Hair Salon', business_name: 'Royals Hair' },
  { category: 'Nail Salon', business_name: 'Gloss Nail Studio' },
  { category: 'Massage & Spa', business_name: 'Endota Spa' },
] as const

const FOLLOW_UP_TYPES = [
  'follow_up_1',
  'follow_up_2',
  'follow_up_3',
] as const

async function main() {
  const { writeOutreachEmail } = await import('@/ai/workflows')
  const { generateFollowUpEmail } = await import('@/lib/followup-generation')

  for (const sample of SAMPLE_BUSINESSES) {
    const business = {
      ...sample,
      suburb: 'Sydney',
      city: 'Sydney',
      website: '',
      description: '',
      services: '',
      content_type: 'visit',
    }

    // Follow-ups stay in the original outreach thread in production, so obtain
    // that thread's real subject with the same initial-email writer.
    const initial = await writeOutreachEmail(business)
    const history: FollowUpThreadEmail[] = [
      { type: 'initial_pitch', subject: initial.subject, body: initial.body },
    ]

    console.log('='.repeat(50))
    console.log(`CATEGORY: ${sample.category}`)
    console.log('='.repeat(50))

    for (const [index, type] of FOLLOW_UP_TYPES.entries()) {
      const followUp = await generateFollowUpEmail(
        type,
        {
          businessName: business.business_name,
          category: business.category,
          suburb: business.suburb,
          city: business.city,
          website: business.website,
          description: business.description,
          services: business.services,
          notes: '',
          contentType: business.content_type,
        },
        initial.subject,
        history
      )

      console.log(`\nFOLLOW-UP ${index + 1}`)
      console.log(`Subject: ${followUp.subject}`)
      console.log('Body:')
      console.log(followUp.body)

      history.push({ type, subject: followUp.subject, body: followUp.body })
    }

    console.log()
  }
}

main().catch((error) => {
  console.error('Fatal:', error instanceof Error ? error.message : error)
  process.exit(1)
})
