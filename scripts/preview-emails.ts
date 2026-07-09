import * as dotenv from 'dotenv'
import { resolve } from 'path'

dotenv.config({ path: resolve(__dirname, '../.env.local') })

import Anthropic from '@anthropic-ai/sdk'
import { getBrandDescription, buildOutreachEmailPrompt } from '@/lib/claude'
import { resolveContentType } from '@/lib/content-type'

const SAMPLES = [
  {
    label: 'Halal Restaurant — Sydney',
    business_name: 'Taste of Istanbul',
    category: 'Halal Restaurants',
    suburb: 'Lakemba',
    city: 'Sydney',
  },
  {
    label: 'Halal Cafe — Sydney',
    business_name: 'Marhaba Cafe',
    category: 'Halal Cafes',
    suburb: 'Bankstown',
    city: 'Sydney',
  },
  {
    label: 'Nail Salon — Melbourne',
    business_name: 'Luxe Nails',
    category: 'Nail Salons',
    suburb: 'Melbourne CBD',
    city: 'Melbourne',
  },
  {
    label: 'Travel Agent — Brisbane',
    business_name: 'Explore Australia Travel',
    category: 'Travel Agents',
    suburb: 'Brisbane CBD',
    city: 'Brisbane',
  },
  {
    label: 'Hotel — Sydney',
    business_name: 'Harbour View Hotel',
    category: 'Hotels / Resorts',
    suburb: 'Sydney CBD',
    city: 'Sydney',
  },
  // Categories that don't exist in the DB yet — proves wording adapts via
  // keyword classification, with no code changes needed when they're added.
  {
    label: 'Pet Grooming (unseen category) — Perth',
    business_name: 'Paws & Claws Grooming',
    category: 'Pet Grooming',
    suburb: 'Fremantle',
    city: 'Perth',
  },
  {
    label: 'Serviced Apartments (unseen category) — Sydney',
    business_name: 'Harbourside Stays',
    category: 'Serviced Apartments',
    suburb: 'Pyrmont',
    city: 'Sydney',
  },
]

function buildPrompt(sample: typeof SAMPLES[0]): string {
  const contentType = resolveContentType({ name: sample.category }, sample.city)
  const brandDesc = getBrandDescription(sample.category, contentType)
  return buildOutreachEmailPrompt(sample, brandDesc)
}

function countWords(text: string): number {
  return text.split('Cheers,')[0].trim().split(/\s+/).filter(Boolean).length
}

async function main() {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

  console.log(`Generating ${SAMPLES.length} sample emails...\n`)
  console.log('='.repeat(70))

  for (const sample of SAMPLES) {
    process.stdout.write(`\n${sample.label.toUpperCase()}\n`)
    process.stdout.write('-'.repeat(70) + '\n')

    try {
      const response = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 400,
        messages: [{ role: 'user', content: buildPrompt(sample) }],
      })

      const raw = response.content[0].type === 'text' ? response.content[0].text : ''
      const jsonMatch = raw.match(/\{[\s\S]*\}/)
      if (!jsonMatch) { console.log('ERROR: No JSON\n' + raw); continue }

      const result = JSON.parse(jsonMatch[0]) as { subject: string; body: string }
      const wordCount = countWords(result.body)
      const hasEmDash = result.body.includes('—') || result.subject.includes('—')
      const hasLogistics = /\b(visit|come in|pop in|remote|assets|photos|sponsored|partnership|free|paid collab)\b/i.test(
        result.body.split('Cheers,')[0]
      )
      const bodyWithoutSignoff = result.body.split('Cheers,')[0].trimEnd()
      const endsCorrectly = /would you be keen to collab\??\s*$/i.test(bodyWithoutSignoff)

      console.log(`SUBJECT: ${result.subject}\n`)
      console.log(`BODY:\n${result.body}`)
      console.log('\n--- Checks ---')
      console.log(`Words (excl. sign-off): ${wordCount} ${wordCount <= 80 ? '✓' : '✗ OVER 80'}`)
      console.log(`No em dashes:           ${hasEmDash ? '✗ FOUND EM DASH' : '✓'}`)
      console.log(`No logistics:           ${hasLogistics ? '✗ MENTIONS LOGISTICS' : '✓'}`)
      console.log(`Ends correctly:         ${endsCorrectly ? '✓' : '✗ WRONG CLOSING LINE'}`)
    } catch (err) {
      console.log(`ERROR: ${err}`)
    }

    console.log('='.repeat(70))
  }

  console.log('\nAll done.')
}

main()
