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

interface OutscraperJobResponse {
  id: string
  status: string
  results_location: string
  data?: OutscraperResult[][]
}

const POLL_INTERVAL_MS = 3_000
const MAX_POLL_ATTEMPTS = 20

let outscraperCallCount = 0
let outscraperCallWindowStart = Date.now()
const OUTSCRAPER_RATE_LIMIT = 10

async function rateLimitedFetch(url: string, headers: Record<string, string>): Promise<Response> {
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
  return fetch(url, { headers })
}

async function pollResults(resultsUrl: string, headers: Record<string, string>): Promise<OutscraperResult[]> {
  for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))

    const res = await fetch(resultsUrl, { headers })
    if (!res.ok) throw new Error(`Outscraper poll error: ${res.status}`)

    const job = await res.json() as OutscraperJobResponse
    console.log(`Outscraper poll ${attempt}/${MAX_POLL_ATTEMPTS}: status=${job.status}`)

    if (job.status !== 'Pending') {
      return job.data?.flat() ?? []
    }
  }

  console.warn('Outscraper: max poll attempts reached, giving up')
  return []
}

export async function searchBusinesses(query: string, limit = 20): Promise<OutscraperResult[]> {
  const apiKey = (process.env.OUTSCRAPER_API_KEY ?? '').trim()
  const params = new URLSearchParams({
    query,
    limit: String(limit),
    language: 'en',
    region: 'AU',
  })

  const url = `https://api.app.outscraper.com/maps/search-v3?${params}&apiKey=${encodeURIComponent(apiKey)}`
  const headers = { 'X-API-KEY': apiKey }

  console.log(`Outscraper search: "${query}"`)

  try {
    const response = await rateLimitedFetch(url, headers)

    if (!response.ok) {
      throw new Error(`Outscraper API error: ${response.status}`)
    }

    const job = await response.json() as OutscraperJobResponse
    console.log(`Outscraper job queued: id=${job.id} status=${job.status}`)

    // Synchronous response (unlikely for v3 but handle it)
    if (job.status !== 'Pending' && job.data) {
      return job.data.flat()
    }

    // Async response — poll results_location
    if (job.results_location) {
      return await pollResults(job.results_location, headers)
    }

    console.warn('Outscraper: no results_location in response')
    return []
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
