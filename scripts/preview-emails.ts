import * as dotenv from 'dotenv'
import { resolve } from 'path'

dotenv.config({ path: resolve(__dirname, '../.env.local') })

import { aiRegistry } from '@/ai/AIRuntime'
import { buildOutreachEmailPrompt, OUTREACH_EMAIL_SYSTEM_PROMPT } from '@/ai/workflows'
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
  return buildOutreachEmailPrompt(sample, contentType)
}

function countWords(text: string): number {
  return text.split('Cheers,')[0].trim().split(/\s+/).filter(Boolean).length
}

// The specific wordings that mark an email as agency/AI-written rather than
// typed by a person. Mirrors BANNED_WORDING in src/lib/email-voice.ts — that
// list instructs the model, this one catches it when it ignores the instruction.
const BANNED_TELLS: RegExp[] = [
  /\b(perfect|great|ideal|good) fit\b/i,
  /our (audience|followers)\b/i,
  /would (love|resonate)\b/i,
  /\bresonate\b/i,
  /\bauthentic\b/i,
  /\bengag(ing|ement)\b/i,
  /\bshowcase\b/i,
  /\b(immersive|vibrant|iconic|curated|elevate|amplify|leverage|synergy)\b/i,
  /hidden gem|must[- ]visit|game changer|one of a kind|next level/i,
  /\b(excited|thrilled|buzzing|stoked)\b/i,
  /\bI (came|stumbled) across\b/i,
  /\bI wanted to (reach out|see)\b/i,
  /hope this (email )?finds you well/i,
  /just checking in|touching base|circling back/i,
  /worth a quick chat|quick chat/i,
  /we'?d love to\b/i,
]

async function main() {
  console.log(`Generating ${SAMPLES.length} sample emails...\n`)
  console.log('='.repeat(70))

  for (const sample of SAMPLES) {
    process.stdout.write(`\n${sample.label.toUpperCase()}\n`)
    process.stdout.write('-'.repeat(70) + '\n')

    try {
      const response = await aiRegistry.generate('outreach_email_generation', {
        maxTokens: 400,
        system: OUTREACH_EMAIL_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildPrompt(sample) }],
      })

      const raw = response.text
      const jsonMatch = raw.match(/\{[\s\S]*\}/)
      if (!jsonMatch) { console.log('ERROR: No JSON\n' + raw); continue }

      const result = JSON.parse(jsonMatch[0]) as { subject: string; body: string }
      const bodyWithoutSignoff = result.body.split('Cheers,')[0].trimEnd()
      const wordCount = countWords(result.body)
      const hasEmDash = result.body.includes('—') || result.subject.includes('—')
      const hasLogistics = /\b(visit|come in|pop in|remote|assets|photos|video|sponsored|partnership|package|price|pricing|cost|budget|free|paid)\b/i.test(
        bodyWithoutSignoff
      )
      // The ask must be a plain direct question, not a copywriter's closing line.
      const endsCorrectly = /\?\s*$/.test(bodyWithoutSignoff) &&
        /\b(interested|interest|working together|something together|a collab)\b/i.test(
          bodyWithoutSignoff.split('\n').filter(Boolean).slice(-1)[0] ?? ''
        )
      const banned = BANNED_TELLS.filter((re) => re.test(bodyWithoutSignoff) || re.test(result.subject))
      const hasBangOrEmoji = /!/.test(bodyWithoutSignoff) || /[\u{1F300}-\u{1FAFF}]/u.test(result.body)

      console.log(`SUBJECT: ${result.subject}\n`)
      console.log(`BODY:\n${result.body}`)
      console.log('\n--- Checks ---')
      console.log(`Words (excl. sign-off): ${wordCount} ${wordCount <= 75 ? '✓' : '✗ OVER 75'}`)
      console.log(`No em dashes:           ${hasEmDash ? '✗ FOUND EM DASH' : '✓'}`)
      console.log(`No logistics/pricing:   ${hasLogistics ? '✗ MENTIONS LOGISTICS' : '✓'}`)
      console.log(`No ! or emoji:          ${hasBangOrEmoji ? '✗ FOUND' : '✓'}`)
      console.log(`Ends on a plain ask:    ${endsCorrectly ? '✓' : '✗ WEAK OR MISSING ASK'}`)
      console.log(`No banned wording:      ${banned.length === 0 ? '✓' : `✗ ${banned.map((r) => r.source).join(', ')}`}`)
    } catch (err) {
      console.log(`ERROR: ${err}`)
    }

    console.log('='.repeat(70))
  }

  console.log('\nAll done.')
}

main()
