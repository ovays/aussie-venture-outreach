import { aiRegistry } from './AIRuntime'

export async function extractEmailWithHaiku(content: string, businessName: string): Promise<string | null> {
  const response = await aiRegistry.generate('contact_email_extraction', {
    maxTokens: 64,
    messages: [
      {
        role: 'user',
        content: `Find a contact email address for "${businessName}" in this text. Return ONLY the email address, nothing else. If no email is found, return "none".\n\n${content.slice(0, 3000)}`,
      },
    ],
  })

  const text = response.text.trim()
  if (text && text.toLowerCase() !== 'none' && text.includes('@') && !text.includes(' ') && text.length < 100) {
    return text
  }
  return null
}

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
    const response = await aiRegistry.generate('agentic_email_search', {
      maxTokens: 256,
      system: SYSTEM,
      messages,
    })

    const raw = response.text || '{}'
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
