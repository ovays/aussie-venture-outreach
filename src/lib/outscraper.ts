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

// normalize phone
function normalizePhone(p?: string) {
  return p?.replace(/\D/g, '')
}

// dedupe function
function dedupeResults(results: OutscraperResult[]): OutscraperResult[] {
  const seen = new Set<string>()

  return results.filter((r) => {
    const key =
      normalizePhone(r.phone) ||
      `${r.name?.toLowerCase()}-${r.full_address?.toLowerCase()}`

    if (!key) return true
    if (seen.has(key)) return false

    seen.add(key)
    return true
  })
}

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

async function pollResults(
  resultsUrl: string,
  headers: Record<string, string>,
  apiKey: string
): Promise<OutscraperResult[]> {

  for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
    const wait = attempt < 3 ? 2000 : 4000
    await new Promise((r) => setTimeout(r, wait))

    const pollUrl = `${resultsUrl}?apiKey=${encodeURIComponent(apiKey)}`

    console.log("Polling URL:", pollUrl)

    const res = await rateLimitedFetch(pollUrl, headers)

    if (!res.ok) {
      const text = await res.text()
      console.error("Outscraper POLL ERROR:", res.status, text)
      throw new Error(`Outscraper poll error: ${res.status}`)
    }

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

  const cleanKey = (process.env.OUTSCRAPER_API_KEY ?? '')
    .replace(/[^\x20-\x7E]/g, '')
    .trim()

  const params = new URLSearchParams({
    query,
    limit: String(limit),
    language: 'en',
    region: 'AU',
  })

  const url = `https://api.app.outscraper.com/maps/search-v3?${params}&apiKey=${encodeURIComponent(cleanKey)}`
  const headers: Record<string, string> = {}

  // 🔥 DEBUG LOGGING
  console.log("==== Outscraper DEBUG START ====")
  console.log("Query:", query)
  console.log("ENV KEY EXISTS:", process.env.OUTSCRAPER_API_KEY ? "YES" : "NO")
  console.log("Clean Key Length:", cleanKey.length)
  console.log("Clean Key Preview:", cleanKey.substring(0, 6) + "...")
  console.log("Request URL:", url)
  console.log("==== Outscraper DEBUG END ====")

  try {
    const response = await rateLimitedFetch(url, headers)

    if (!response.ok) {
      const text = await response.text()
      console.error("Outscraper FULL ERROR:", response.status, text)
      throw new Error(`Outscraper API error: ${response.status}`)
    }

    const job = await response.json() as OutscraperJobResponse
    console.log(`Outscraper job queued: id=${job.id} status=${job.status}`)

    let results: OutscraperResult[] = []

    // Synchronous
    if (job.status !== 'Pending' && job.data) {
      results = job.data.flat()
    }

    // Async
    else if (job.results_location) {
      results = await pollResults(job.results_location, headers, cleanKey)
    }

    else {
      console.warn('Outscraper: no results_location in response')
      return []
    }

    const uniqueResults = dedupeResults(results)

    console.log(`Deduped results: ${results.length} → ${uniqueResults.length}`)

    return uniqueResults

  } catch (error) {
    console.error('Outscraper FINAL ERROR:', error)
    return []
  }
}

export function buildSearchQuery(keyword: string, suburb: string, city: string): string {
  return keyword
    .replace('{suburb}', suburb)
    .replace('{city}', city)
}