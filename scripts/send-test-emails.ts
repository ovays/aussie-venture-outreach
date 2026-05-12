import * as dotenv from 'dotenv'
import { resolve } from 'path'

dotenv.config({ path: resolve(__dirname, '../.env.local') })

import Anthropic from '@anthropic-ai/sdk'
import { Resend } from 'resend'

const TO = 'owais_ahmed12@hotmail.com'
const FROM = 'Owais | Aussie Venture <hello@aussieventure.com>'

const SAMPLES = [
  {
    label: 'Halal Restaurant (Sydney - visit)',
    business_name: 'Taste of Istanbul',
    category: 'Halal Restaurants',
    suburb: 'Lakemba',
    city: 'Sydney',
    content_type: 'visit',
  },
  {
    label: 'Halal Cafe (Sydney - visit)',
    business_name: 'Marhaba Cafe',
    category: 'Halal Cafes',
    suburb: 'Bankstown',
    city: 'Sydney',
    content_type: 'visit',
  },
  {
    label: 'Nail Salon (Melbourne - remote)',
    business_name: 'Luxe Nails',
    category: 'Nail Salons',
    suburb: 'Melbourne CBD',
    city: 'Melbourne',
    content_type: 'remote',
  },
  {
    label: 'Travel Agent (Brisbane - remote)',
    business_name: 'Explore Australia Travel',
    category: 'Travel Agents',
    suburb: 'Brisbane',
    city: 'Brisbane',
    content_type: 'remote',
  },
  {
    label: 'Hotel / Resort (Sydney - remote)',
    business_name: 'Harbour View Hotel',
    category: 'Hotels / Resorts',
    suburb: 'Sydney CBD',
    city: 'Sydney',
    content_type: 'remote',
  },
]

function getCategoryPitch(category: string, contentType: string): string {
  const halalFood = ['Halal Restaurants', 'Halal Cafes', 'Halal Bakeries / Dessert Shops']
  const beauty = ['Nail Salons', 'Hair Salons', 'Beauty / Lash Studios']
  const wellness = ['Spas / Massage Studios']
  const travel = ['Travel Agents', 'Tour Operators']
  const accommodation = ['Hotels / Resorts']

  if (halalFood.includes(category)) {
    return `Owais is building halal food content and wants to visit the restaurant, experience the food and put together a sponsored feature for his 650K+ audience across Facebook, Instagram and TikTok. He is offering sponsored exposure, not asking for a favour.

NEVER say: free meal, free visit, free anything, no cost, no charge
NEVER say: paid collab
DO say: sponsored feature or content partnership
DO say: I'd love to come in, experience the food and put together a sponsored feature for my audience`
  }
  if (beauty.includes(category)) {
    return `Owais creates lifestyle content for 650K+ Australians across Facebook, Instagram and TikTok and is offering a sponsored feature or content partnership to this business. He is selling media space, not asking for a favour.

NEVER say: free, no cost, no charge
NEVER say: paid collab
DO say: sponsored feature, sponsored post, or content partnership
DO say: we create lifestyle content and would love to put together a sponsored feature`
  }
  if (wellness.includes(category)) {
    return `Owais creates lifestyle content for 650K+ Australians across Facebook, Instagram and TikTok and is offering a sponsored feature or content partnership to this wellness business. He is selling media space, not asking for a favour.

NEVER say: free, no cost, no charge
NEVER say: paid collab
DO say: sponsored feature, sponsored post, or content partnership
DO say: we create lifestyle content and would love to put together a sponsored feature`
  }
  if (travel.includes(category)) {
    return `Owais creates Australian travel content for 650K+ Australians across Facebook, Instagram and TikTok and is offering a sponsored post, sponsored feature, or content partnership to this travel business. He is selling media space, not asking for a favour.

NEVER say: free, no cost, no charge
NEVER say: paid collab
DO say: sponsored feature, sponsored post, or content partnership
DO say: we create Australian travel content and would love to put together a sponsored feature or content partnership`
  }
  if (accommodation.includes(category)) {
    return `Owais creates Australian travel and lifestyle content for 650K+ Australians across Facebook, Instagram and TikTok and is offering to feature this property in a sponsored post or content partnership. He is selling media space, not asking for a favour.

NEVER say: free stay, free anything, no cost, no charge
NEVER say: paid collab
DO say: sponsored feature, sponsored post, or content partnership
DO say: we create Australian travel content and would love to feature the property in a sponsored post`
  }
  return contentType === 'visit'
    ? `Owais wants to visit, experience what they offer and put together a sponsored feature for his 650K+ audience across Facebook, Instagram and TikTok.`
    : `Owais creates Australian lifestyle content for 650K+ Australians across Facebook, Instagram and TikTok and is offering a sponsored feature or content partnership to this business.`
}

function buildPrompt(sample: typeof SAMPLES[0]): string {
  const pitch = getCategoryPitch(sample.category, sample.content_type)
  return `You are Owais. You run Aussie Venture, an Australian food, travel and lifestyle brand. Write a short outreach email to a local business.

FACTS about Aussie Venture (only state these, never invent others):
- Australian food, travel and lifestyle brand
- Based in Sydney
- Creates content about food, travel and lifestyle in Australia
- 650K+ followers across Facebook, Instagram and TikTok
- Instagram: @aussie.venture | Facebook: facebook.com/AussieVenture
- Website: aussieventure.com

Business you are emailing:
- Name: ${sample.business_name}
- Category: ${sample.category}
- Location: ${sample.suburb}, ${sample.city}

What to pitch (be honest, stick exactly to this angle):
${pitch}

HARD RULES - break any of these and the email is wrong:
- Body must be under 100 words (not counting the sign-off)
- No em dashes (no — character, ever, anywhere)
- No bullet points in the body
- No corporate language: "leverage", "synergy", "reach out", "touch base", "I wanted to", "opportunity", "I hope this finds you well", "I came across"
- You may mention "650K+ followers across Facebook, Instagram and TikTok" once if it adds credibility - never invent any other numbers
- Never say what the audience "always asks for" or what content "performs best" - we don't know that
- No lists of deliverables ("photos, reels, captions") - just say "create content" or "put something together"
- NEVER mention free meals, free visits, free stays, or anything being free or at no cost
- NEVER say "paid collab" - use "sponsored feature", "sponsored post", or "content partnership" instead
- Never state a price or budget in this email - just gauge interest
- 3 short paragraphs max, each paragraph 1-2 sentences
- Start with "Hey" followed by the business name
- Last line must be exactly "Would you be keen?" or "Keen to work together?" - nothing else
- Sound like a real 25-year-old Australian writing a casual email, not a PR agency

Sign off (always exactly this):
Cheers,
Owais
Aussie Venture
hello@aussieventure.com

Subject line: short, specific, no clickbait

Respond in JSON: { "subject": "...", "body": "..." }`
}

function bodyToHtml(text: string, label: string): string {
  // Split on double newline for paragraphs, single newline for line breaks in sign-off
  const parts = text.split(/\n\n+/)
  const paragraphs = parts.map((p) => {
    const lines = p.trim().split('\n').map((l) => l.trim()).filter(Boolean)
    if (lines.length === 1) return `<p style="margin:0 0 18px;color:#374151;">${lines[0]}</p>`
    // Sign-off block: render as small stacked lines
    return `<p style="margin:0 0 4px;color:#374151;">${lines.join('<br>')}</p>`
  }).join('\n')

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:560px;margin:40px auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">

    <!-- Header -->
    <div style="background:#0f1117;padding:20px 32px 16px;">
      <p style="margin:0;font-size:20px;font-weight:700;color:#ffffff;">Aussie Venture</p>
      <p style="margin:4px 0 0;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:1px;">Outreach Test</p>
    </div>

    <!-- Label badge -->
    <div style="background:#f0f9ff;border-bottom:1px solid #e0f2fe;padding:10px 32px;">
      <p style="margin:0;font-size:12px;color:#0369a1;font-weight:600;">${label}</p>
    </div>

    <!-- Body -->
    <div style="padding:28px 32px 8px;font-size:15px;line-height:1.75;">
      ${paragraphs}
    </div>

    <!-- Footer -->
    <div style="background:#f8fafc;padding:14px 32px;border-top:1px solid #e5e7eb;margin-top:16px;">
      <p style="margin:0;font-size:11px;color:#9ca3af;text-align:center;">
        Test send from ReachAgent
      </p>
    </div>

  </div>
</body>
</html>`
}

async function main() {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })
  const resend = new Resend(process.env.RESEND_API_KEY!)

  console.log(`Generating and sending ${SAMPLES.length} test emails to ${TO}...\n`)
  console.log('='.repeat(70))

  for (const sample of SAMPLES) {
    process.stdout.write(`\n${sample.label.toUpperCase()}\n`)
    process.stdout.write('-'.repeat(70) + '\n')

    try {
      // Generate email body
      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 512,
        messages: [{ role: 'user', content: buildPrompt(sample) }],
      })

      const raw = response.content[0].type === 'text' ? response.content[0].text : ''
      const jsonMatch = raw.match(/\{[\s\S]*\}/)
      if (!jsonMatch) {
        console.log('ERROR: No JSON in Claude response')
        console.log(raw)
        continue
      }

      const result = JSON.parse(jsonMatch[0]) as { subject: string; body: string }
      console.log(`Subject: ${result.subject}`)
      console.log(`\n${result.body}\n`)

      // Send via Resend
      const html = bodyToHtml(result.body, sample.label)
      const send = await resend.emails.send({
        from: FROM,
        to: TO,
        subject: `[TEST] ${result.subject}`,
        html,
        text: result.body,
      })

      if (send.error) {
        console.log(`SEND FAILED: ${JSON.stringify(send.error)}`)
      } else {
        console.log(`Sent ✓  ID: ${send.data?.id}`)
      }
    } catch (err) {
      console.log(`ERROR: ${err}`)
    }

    console.log('='.repeat(70))
  }

  console.log(`\nAll done. Check ${TO} for 5 test emails.`)
}

main()
