import Anthropic from '@anthropic-ai/sdk'

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY!,
})

const HAIKU_MODEL = 'claude-haiku-4-5-20251001'
const SONNET_MODEL = 'claude-sonnet-4-6'

let claudeCallCount = 0
let claudeCallWindowStart = Date.now()
const CLAUDE_RATE_LIMIT = 20

async function rateLimitedCall<T>(fn: () => Promise<T>): Promise<T> {
  const now = Date.now()
  if (now - claudeCallWindowStart > 60_000) {
    claudeCallCount = 0
    claudeCallWindowStart = now
  }
  if (claudeCallCount >= CLAUDE_RATE_LIMIT) {
    const wait = 60_000 - (now - claudeCallWindowStart)
    await new Promise((r) => setTimeout(r, wait))
    claudeCallCount = 0
    claudeCallWindowStart = Date.now()
  }
  claudeCallCount++
  return fn()
}

function getBrandDescription(category: string): string {
  const food = ['Halal Restaurants', 'Halal Cafes', 'Halal Bakeries / Dessert Shops']
  const beauty = ['Nail Salons', 'Hair Salons', 'Beauty / Lash Studios', 'Spas / Massage Studios']
  const travel = ['Travel Agents', 'Tour Operators', 'Hotels / Resorts']

  if (food.includes(category)) return 'Sydney-based food, travel and lifestyle brand'
  if (beauty.includes(category)) return 'Sydney-based lifestyle brand'
  if (travel.includes(category)) return 'Sydney-based travel and lifestyle brand'
  return 'Sydney-based food, travel and lifestyle brand'
}

function getCategoryPitch(category: string): string {
  const halalFood = ['Halal Restaurants', 'Halal Cafes', 'Halal Bakeries / Dessert Shops']
  const beauty = ['Nail Salons', 'Hair Salons', 'Beauty / Lash Studios']
  const wellness = ['Spas / Massage Studios']
  const travel = ['Travel Agents', 'Tour Operators']
  const accommodation = ['Hotels / Resorts']

  if (halalFood.includes(category)) return 'Owais creates halal food content for 500K+ Australians and wants to collab with this business.'
  if (beauty.includes(category)) return 'Owais creates lifestyle content for 500K+ Australians and wants to collab with this business.'
  if (wellness.includes(category)) return 'Owais creates lifestyle content for 500K+ Australians and wants to collab with this business.'
  if (travel.includes(category)) return 'Owais creates Australian travel content for 500K+ Australians and wants to collab with this business.'
  if (accommodation.includes(category)) return 'Owais creates Australian travel and lifestyle content for 500K+ Australians and wants to collab with this property.'
  return 'Owais creates Australian food, travel and lifestyle content for 500K+ Australians and wants to collab with this business.'
}

export async function extractWebsiteData(websiteContent: string): Promise<{
  description: string
  services: string
  instagram_handle: string | null
  facebook_url: string | null
  other_social: string | null
}> {
  const response = await rateLimitedCall(() =>
    anthropic.messages.create({
      model: HAIKU_MODEL,
      max_tokens: 512,
      messages: [
        {
          role: 'user',
          content: `Extract the following from this business website content:
- Brief description (1-2 sentences)
- Main services offered
- Instagram handle (if mentioned, just the handle like @businessname)
- Facebook URL (if mentioned)
- Any other social media

Website content: ${websiteContent.slice(0, 4000)}

Respond in JSON only with keys: description, services, instagram_handle, facebook_url, other_social`,
        },
      ],
    })
  )

  const text = response.content[0].type === 'text' ? response.content[0].text : ''
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0])
    }
  } catch {
    // fallback
  }
  return {
    description: '',
    services: '',
    instagram_handle: null,
    facebook_url: null,
    other_social: null,
  }
}

export async function writeOutreachEmail(params: {
  business_name: string
  category: string
  suburb: string
  city: string
  website: string
  description: string
  services: string
  content_type: string
}): Promise<{ subject: string; body: string }> {
  const response = await rateLimitedCall(() =>
    anthropic.messages.create({
      model: SONNET_MODEL,
      max_tokens: 400,
      messages: [
        {
          role: 'user',
          content: `You are Owais. You run Aussie Venture, an Australian ${getBrandDescription(params.category)}. Write a very short first outreach email to a local business.

FACTS (only use these, never invent others):
- Aussie Venture is a ${getBrandDescription(params.category)} with a national audience
- 500K+ followers across Facebook, Instagram and TikTok

Business: ${params.business_name}, ${params.suburb} ${params.city}
Category: ${params.category}

WHAT THE EMAIL MUST DO:
1. Open with "Hey ${params.business_name},"
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

Respond in JSON: { "subject": "...", "body": "..." }`,
        },
      ],
    })
  )

  const text = response.content[0].type === 'text' ? response.content[0].text : ''
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0])
    }
  } catch {
    // fallback
  }
  return {
    subject: `Collab with Aussie Venture - ${params.business_name}`,
    body: `Hey ${params.business_name},\n\nI run Aussie Venture, a ${getBrandDescription(params.category)} with 500K+ followers across Facebook, Instagram and TikTok. Would love to work together.\n\nWould you be keen to collab?\n\nCheers,\nOwais\nAussie Venture\nhello@aussieventure.com\naussieventure.com\ninstagram.com/aussie.venture\ntiktok.com/@aussie.venture\nfacebook.com/AussieVenture\nfacebook.com/Sydneyventure`,
  }
}

export async function writeOutreachDM(params: {
  business_name: string
  suburb: string
  city: string
  category: string
}): Promise<string> {
  const pitch = getCategoryPitch(params.category)

  const response = await rateLimitedCall(() =>
    anthropic.messages.create({
      model: SONNET_MODEL,
      max_tokens: 200,
      messages: [
        {
          role: 'user',
          content: `You're Owais. You run Aussie Venture, an Australian food, travel and lifestyle brand with 500K+ followers across Facebook, Instagram and TikTok. Write a short Instagram DM to this business.

Business: ${params.business_name}, ${params.suburb} ${params.city}
Category: ${params.category}

Pitch angle: ${pitch.split('\n')[0]}

Rules:
- Max 2-3 sentences
- Sound like a real person, not a brand
- No em dashes, no bullet points, no corporate language
- No "I wanted to reach out", no "I came across your page"
- You may mention 500K+ followers once if it adds credibility
- NEVER mention free, no cost, no charge, or anything being free
- NEVER say "paid collab" - use "sponsored feature" or "collab" instead
- Never state a price
- Casual and direct
- End with "Would you be keen?" or "Keen to work together?"

Respond with just the DM text, nothing else.`,
        },
      ],
    })
  )

  return response.content[0].type === 'text' ? response.content[0].text : ''
}
