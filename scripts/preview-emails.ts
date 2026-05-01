import * as dotenv from 'dotenv'
import { resolve } from 'path'

dotenv.config({ path: resolve(__dirname, '../.env.local') })

import Anthropic from '@anthropic-ai/sdk'

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
]

function getBrandDescription(category: string): string {
  const food = ['Halal Restaurants', 'Halal Cafes', 'Halal Bakeries / Dessert Shops']
  const beauty = ['Nail Salons', 'Hair Salons', 'Beauty / Lash Studios', 'Spas / Massage Studios']
  const travel = ['Travel Agents', 'Tour Operators', 'Hotels / Resorts']

  if (food.includes(category)) return 'Sydney-based food, travel and lifestyle brand'
  if (beauty.includes(category)) return 'Sydney-based lifestyle brand'
  if (travel.includes(category)) return 'Sydney-based travel and lifestyle brand'
  return 'Sydney-based food, travel and lifestyle brand'
}

function buildPrompt(sample: typeof SAMPLES[0]): string {
  const brandDesc = getBrandDescription(sample.category)
  return `You are Owais. You run Aussie Venture, an Australian ${brandDesc}. Write a very short first outreach email to a local business.

FACTS (only use these, never invent others):
- Aussie Venture is a ${brandDesc} with a national audience
- 500K+ followers across Facebook, Instagram and TikTok

Business: ${sample.business_name}, ${sample.suburb} ${sample.city}
Category: ${sample.category}

WHAT THE EMAIL MUST DO:
1. Open with "Hey ${sample.business_name},"
2. Briefly introduce yourself and Aussie Venture — mention the 500K+ followers once
3. Say you'd love to work together or collab
4. End with exactly: "Would you be keen to collab?"

HARD RULES — break any of these and the email is wrong:
- Under 80 words (not counting sign-off)
- NO mention of: visiting, coming in, remote, assets, photos, sponsored post, sponsored feature, content partnership, price, budget, free, paid — save all logistics for after they reply
- Think of it like a first message — just spark interest, nothing more
- No em dashes (no — character)
- No bullet points
- No corporate language: "leverage", "synergy", "reach out", "I wanted to", "I hope this finds you well", "I came across"
- 2 short paragraphs max
- Sound like a real 25-year-old Australian, casual
- Last line must be exactly: "Would you be keen to collab?"

Sign off (use exactly this, every line, nothing more and nothing less):
Cheers,
Owais
Aussie Venture
hello@aussieventure.com
aussieventure.com
instagram.com/aussie.venture
tiktok.com/@aussie.venture
facebook.com/AussieVenture
facebook.com/Sydneyventure

Subject: short and casual, e.g. "Collab with Aussie Venture?" or "Working together?"

Respond in JSON: { "subject": "...", "body": "..." }`
}

function countWords(text: string): number {
  return text.split('Cheers,')[0].trim().split(/\s+/).filter(Boolean).length
}

async function main() {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

  console.log('Generating 5 sample emails...\n')
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
