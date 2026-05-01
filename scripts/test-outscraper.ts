import { readFileSync } from 'fs'
import { resolve } from 'path'

// Load .env.local manually
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

const rawKey = process.env.OUTSCRAPER_API_KEY ?? ''
const apiKey = rawKey.trim()

console.log('=== Outscraper API Key Diagnostics ===')
console.log('Key exists          :', !!apiKey)
console.log('Raw length          :', rawKey.length)
console.log('Trimmed length      :', apiKey.length)
console.log('First 20 chars      :', apiKey.substring(0, 20))
console.log('Last 10 chars       :', apiKey.slice(-10))
console.log('Has non-ASCII chars :', /[^\x00-\x7F]/.test(apiKey))
console.log('Has whitespace      :', /\s/.test(apiKey))
console.log()

const POLL_INTERVAL_MS = 3_000
const MAX_POLL_ATTEMPTS = 20
const headers = { 'X-API-KEY': apiKey }

interface JobResponse {
  id: string
  status: string
  results_location: string
  data?: unknown[][]
}

async function pollResults(resultsUrl: string): Promise<unknown> {
  for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
    const res = await fetch(resultsUrl, { headers })
    const job = await res.json() as JobResponse
    console.log(`  Poll ${attempt}/${MAX_POLL_ATTEMPTS}: status=${job.status}`)
    if (job.status !== 'Pending') return job
  }
  return { error: 'max polls reached' }
}

async function main() {
  const query = 'halal restaurant Lakemba Sydney'
  const params = new URLSearchParams({ query, limit: '3', language: 'en', region: 'AU' })
  const url = `https://api.app.outscraper.com/maps/search-v3?${params}&apiKey=${encodeURIComponent(apiKey)}`

  console.log('=== Initial Request ===')
  console.log('URL     :', `https://api.app.outscraper.com/maps/search-v3?${params}`)
  console.log('Headers :', JSON.stringify(headers))
  console.log()

  const res = await fetch(url, { headers })
  console.log('Status  :', res.status, res.statusText)

  const job = await res.json() as JobResponse
  console.log('Job ID  :', job.id)
  console.log('Status  :', job.status)
  console.log('Poll URL:', job.results_location)
  console.log()

  if (job.status === 'Pending' && job.results_location) {
    console.log('=== Polling for results ===')
    const result = await pollResults(job.results_location)
    console.log()
    console.log('=== Final Response ===')
    console.log(JSON.stringify(result, null, 2).slice(0, 3000))
  } else {
    console.log('=== Response (synchronous) ===')
    console.log(JSON.stringify(job, null, 2).slice(0, 3000))
  }
}

main().catch(console.error)
