import { readFileSync } from 'fs'
import { resolve } from 'path'

const envPath = resolve(process.cwd(), '.env.local')
const envRaw = readFileSync(envPath, 'utf-8')
for (const line of envRaw.split('\n')) {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) continue
  const eq = trimmed.indexOf('=')
  if (eq === -1) continue
  const key = trimmed.slice(0, eq).trim()
  const val = trimmed.slice(eq + 1).trim()
  if (!process.env[key]) process.env[key] = val
}

const apiKey = (process.env.OUTSCRAPER_API_KEY ?? '').replace(/[^\x20-\x7E]/g, '').trim()
const ENDPOINT = 'maps/search-v3'
const QUERY = 'travel agent Sydney CBD'
const LIMIT = 5

interface OutscraperResult {
  name: string
  email?: string
  website?: string
  [key: string]: unknown
}

interface JobResponse {
  id: string
  status: string
  results_location: string
  data?: OutscraperResult[][]
}

async function pollResults(resultsUrl: string, headers: Record<string, string>): Promise<OutscraperResult[]> {
  for (let attempt = 1; attempt <= 20; attempt++) {
    const wait = attempt < 3 ? 2000 : 4000
    await new Promise((r) => setTimeout(r, wait))
    const res = await fetch(resultsUrl, { headers })
    const job = await res.json() as JobResponse
    console.log(`  Poll ${attempt}/20: status=${job.status}`)
    if (job.status !== 'Pending') return job.data?.flat() ?? []
  }
  return []
}

async function search(label: string, extraParams?: Record<string, string>): Promise<OutscraperResult[]> {
  const headers = { 'X-API-KEY': apiKey }
  const params = new URLSearchParams({
    query: QUERY,
    limit: String(LIMIT),
    language: 'en',
    region: 'AU',
    ...extraParams,
  })

  console.log(`\n=== ${label} ===`)
  console.log(`Params: ${params}`)

  const url = `https://api.app.outscraper.com/${ENDPOINT}?${params}`
  const res = await fetch(url, { headers })

  if (!res.ok) {
    console.error(`HTTP ${res.status}:`, await res.text())
    return []
  }

  const job = await res.json() as JobResponse
  console.log(`Job ID: ${job.id}, Status: ${job.status}`)

  let results: OutscraperResult[] = []

  if (job.status !== 'Pending' && job.data) {
    results = job.data.flat()
  } else if (job.results_location) {
    const pollUrl = job.results_location.replace(
      /https?:\/\/[^/]*datapipelineplatform\.cloud/,
      'https://api.app.outscraper.com'
    )
    results = await pollResults(pollUrl, headers)
  }

  return results
}

function summarise(label: string, results: OutscraperResult[]): number {
  let withEmail = 0
  let withWebsite = 0
  for (const r of results) {
    const hasEmail = !!(r.email && r.email !== 'null' && r.email !== '')
    const hasWebsite = !!(r.website && r.website !== 'null' && r.website !== '')
    if (hasEmail) withEmail++
    if (hasWebsite) withWebsite++
    console.log(`  ${r.name} — email: ${hasEmail ? 'YES' : 'no'}, website: ${hasWebsite ? 'YES' : 'no'}`)
  }
  console.log(`Summary: ${withEmail}/${results.length} had email, ${withWebsite}/${results.length} had website`)
  return withEmail
}

async function main() {
  console.log(`Query: "${QUERY}", limit=${LIMIT}`)

  const withoutFilter = await search('WITHOUT filter')
  const emailsWithout = summarise('WITHOUT filter', withoutFilter)

  // Small delay between calls to avoid rate limiting
  await new Promise((r) => setTimeout(r, 3000))

  const withFilter = await search('WITH email filter', {
    organizationsFilters: JSON.stringify(["email!='null'"]),
  })
  const emailsWith = summarise('WITH email filter', withFilter)

  console.log('\n=== COMPARISON ===')
  console.log(`WITHOUT filter: ${emailsWithout}/${LIMIT} had emails`)
  console.log(`WITH filter:    ${emailsWith}/${LIMIT} had emails`)
  console.log(`Filter verdict: ${emailsWith >= emailsWithout ? 'WORKS' : 'DOES NOT WORK'}`)
}

main().catch(console.error)
