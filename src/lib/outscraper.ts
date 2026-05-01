export interface OutscraperResult {
  name: string
  full_address: string
  borough: string
  city: string
  postal_code: string
  country_code: string
  phone: string
  site: string
  email: string
  rating: number
  reviews: number
  latitude: number
  longitude: number
}

let outscraperCallCount = 0
let outscraperCallWindowStart = Date.now()
const OUTSCRAPER_RATE_LIMIT = 10

async function rateLimitedFetch(url: string): Promise<Response> {
  const now = Date.now()
  if (now - outscraperCallWindowStart > 60_000) {
    outscraperCallCount = 0
    outscraperCallWindowStart = now
  }
  if (outscraperCallCount >= OUTSCRAPER_RATE_LIMIT) {
    const wait = 60_000 - (now - outscraperCallWindowStart)
    await new Promise((r) => setTimeout(r, wait))
    outscraperCallCount = 0
    outscraperCallWindowStart = Date.now()
  }
  outscraperCallCount++
  return fetch(url)
}

export async function searchBusinesses(query: string, limit = 20): Promise<OutscraperResult[]> {
  const apiKey = process.env.OUTSCRAPER_API_KEY!
  const params = new URLSearchParams({
    query,
    limit: String(limit),
    language: 'en',
    region: 'AU',
  })

  const url = `https://api.app.outscraper.com/maps/search-v3?${params}`

  try {
    const response = await rateLimitedFetch(url)
    if (!response.ok) {
      throw new Error(`Outscraper API error: ${response.status}`)
    }
    const data = await response.json() as { data?: OutscraperResult[][] }
    return data.data?.flat() ?? []
  } catch (error) {
    console.error('Outscraper error:', error)
    return []
  }
}

export function buildSearchQuery(keyword: string, suburb: string, city: string): string {
  return keyword
    .replace('{suburb}', suburb)
    .replace('{city}', city)
}
