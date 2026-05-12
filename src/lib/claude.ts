import Anthropic, { APIError } from '@anthropic-ai/sdk'
import { withRetry } from './retry'

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY!,
})

const HAIKU_MODEL = 'claude-haiku-4-5-20251001'
const SONNET_MODEL = 'claude-sonnet-4-6'

let claudeCallCount = 0
let claudeCallWindowStart = Date.now()
const CLAUDE_RATE_LIMIT = 20

function is529Overload(err: unknown): boolean {
  if (err instanceof APIError) return err.status === 529
  const msg = err instanceof Error ? err.message : String(err)
  return msg.includes('529') || msg.toLowerCase().includes('overloaded')
}

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
  // 3 retries (4 total attempts) for 529 overload: delays ~1s, 2s, 4s
  return withRetry(fn, { maxAttempts: 4, baseDelayMs: 1000, isRetryable: is529Overload })
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

  if (halalFood.includes(category)) return 'Owais creates halal food content for 650K+ Australians and wants to collab with this business.'
  if (beauty.includes(category)) return 'Owais creates lifestyle content for 650K+ Australians and wants to collab with this business.'
  if (wellness.includes(category)) return 'Owais creates lifestyle content for 650K+ Australians and wants to collab with this business.'
  if (travel.includes(category)) return 'Owais creates Australian travel content for 650K+ Australians and wants to collab with this business.'
  if (accommodation.includes(category)) return 'Owais creates Australian travel and lifestyle content for 650K+ Australians and wants to collab with this property.'
  return 'Owais creates Australian food, travel and lifestyle content for 650K+ Australians and wants to collab with this business.'
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
- 650K+ followers across Facebook, Instagram and TikTok

Business: ${params.business_name}, ${params.suburb} ${params.city}
Category: ${params.category}

WHAT THE EMAIL MUST DO:
1. Open with "Hey ${params.business_name},"
2. Briefly introduce yourself and Aussie Venture — mention the 650K+ followers once
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
    body: `Hey ${params.business_name},\n\nI run Aussie Venture, a ${getBrandDescription(params.category)} with 650K+ followers across Facebook, Instagram and TikTok. Would love to work together.\n\nWould you be keen to collab?\n\nCheers,\nOwais\nAussie Venture\nhello@aussieventure.com\naussieventure.com\ninstagram.com/aussie.venture\ntiktok.com/@aussie.venture\nfacebook.com/AussieVenture\nfacebook.com/Sydneyventure`,
  }
}

// ─── Haiku email extractor ───────────────────────────────────────────────────

export async function extractEmailWithHaiku(content: string, businessName: string): Promise<string | null> {
  const response = await rateLimitedCall(() =>
    anthropic.messages.create({
      model: HAIKU_MODEL,
      max_tokens: 64,
      messages: [
        {
          role: 'user',
          content: `Find a contact email address for "${businessName}" in this text. Return ONLY the email address, nothing else. If no email is found, return "none".\n\n${content.slice(0, 3000)}`,
        },
      ],
    })
  )

  const text = response.content[0].type === 'text' ? response.content[0].text.trim() : ''
  if (text && text.toLowerCase() !== 'none' && text.includes('@') && !text.includes(' ') && text.length < 100) {
    return text
  }
  return null
}

// ─── Agentic email search (legacy) ───────────────────────────────────────────

interface AgentDecision {
  action: 'found' | 'fetch_url' | 'search_google' | 'not_found'
  email?: string
  url?: string
  search_query?: string
}

async function fetchPageText(url: string): Promise<string> {
  try {
    const normalised = url.startsWith('http') ? url : `https://${url}`
    const res = await fetch(normalised, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ReachAgentBot/1.0)' },
      signal: AbortSignal.timeout(10_000),
    })
    const html = await res.text()
    return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 4000)
  } catch {
    return ''
  }
}

async function searchWeb(query: string): Promise<string> {
  try {
    const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ReachAgentBot/1.0)',
        Accept: 'text/html',
      },
      signal: AbortSignal.timeout(10_000),
    })
    const html = await res.text()
    return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 4000)
  } catch {
    return ''
  }
}

function parseDecision(text: string): AgentDecision {
  try {
    const m = text.match(/\{[\s\S]*?\}/)
    if (m) return JSON.parse(m[0]) as AgentDecision
  } catch {}
  return { action: 'not_found' }
}

export async function agenticEmailSearch(params: {
  business_name: string
  website_url: string
  category: string
  homepage_content: string
}): Promise<{ email: string | null; method: string; rounds: number }> {
  const MAX_ROUNDS = 3

  const SYSTEM = `You are a research agent that finds contact email addresses for businesses. Respond in valid JSON only — no other text.`

  const firstPrompt = `Find the contact email for this business.

Business: ${params.business_name}
Website: ${params.website_url}
Category: ${params.category}

Homepage content:
${params.homepage_content}

Choose ONE action and respond with JSON only:
- Found an email → {"action":"found","email":"email@domain.com"}
- Need to fetch a subpage → {"action":"fetch_url","url":"/contact"}
- Need an online search → {"action":"search_google","search_query":"${params.business_name} contact email"}
- Cannot find → {"action":"not_found"}`

  const messages: { role: 'user' | 'assistant'; content: string }[] = [
    { role: 'user', content: firstPrompt },
  ]

  let method = 'not_found'

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const response = await rateLimitedCall(() =>
      anthropic.messages.create({
        model: SONNET_MODEL,
        max_tokens: 256,
        system: SYSTEM,
        messages,
      })
    )

    const raw = response.content[0].type === 'text' ? response.content[0].text : '{}'
    const decision = parseDecision(raw)

    console.log(`[email-agent] round=${round} action=${decision.action} email=${decision.email ?? '-'}`)

    if (decision.action === 'found' && decision.email) {
      if (round === 1) method = 'homepage'
      else if (method !== 'google_search') method = 'subpage'
      return { email: decision.email, method, rounds: round }
    }

    if (decision.action === 'not_found') {
      break
    }

    // Execute the suggested action
    let fetchedContent = ''

    if (decision.action === 'fetch_url' && decision.url) {
      let target = decision.url
      if (!target.startsWith('http')) {
        try {
          const base = new URL(
            params.website_url.startsWith('http') ? params.website_url : `https://${params.website_url}`
          )
          target = base.origin + (decision.url.startsWith('/') ? decision.url : `/${decision.url}`)
        } catch {
          target = params.website_url + decision.url
        }
      }
      fetchedContent = await fetchPageText(target)
      method = 'subpage'
    } else if (decision.action === 'search_google' && decision.search_query) {
      fetchedContent = await searchWeb(decision.search_query)
      method = 'google_search'
    }

    messages.push({ role: 'assistant', content: raw })

    if (!fetchedContent) {
      messages.push({
        role: 'user',
        content: 'That returned no content. Try a different approach or return {"action":"not_found"}.',
      })
      continue
    }

    messages.push({
      role: 'user',
      content: `Content from ${decision.action === 'search_google' ? 'search results' : 'that page'}:

${fetchedContent}

Now decide. JSON only: {"action":"found","email":"..."} or {"action":"fetch_url","url":"..."} or {"action":"search_google","search_query":"..."} or {"action":"not_found"}`,
    })
  }

  return { email: null, method: 'not_found', rounds: MAX_ROUNDS }
}

// ─── DM writer ───────────────────────────────────────────────────────────────

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
          content: `You're Owais. You run Aussie Venture, an Australian food, travel and lifestyle brand with 650K+ followers across Facebook, Instagram and TikTok. Write a short Instagram DM to this business.

Business: ${params.business_name}, ${params.suburb} ${params.city}
Category: ${params.category}

Pitch angle: ${pitch.split('\n')[0]}

Rules:
- Max 2-3 sentences
- Sound like a real person, not a brand
- No em dashes, no bullet points, no corporate language
- No "I wanted to reach out", no "I came across your page"
- You may mention 650K+ followers once if it adds credibility
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
