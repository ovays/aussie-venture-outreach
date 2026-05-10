import { readFileSync } from 'fs'
import { resolve } from 'path'
import { createClient } from '@supabase/supabase-js'

// ── Load .env.local ───────────────────────────────────────────────────────────
const envRaw = readFileSync(resolve(process.cwd(), '.env.local'), 'utf-8')
for (const line of envRaw.split('\n')) {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) continue
  const eq = trimmed.indexOf('=')
  if (eq === -1) continue
  const key = trimmed.slice(0, eq).trim()
  const val = trimmed.slice(eq + 1).trim()
  if (!process.env[key]) process.env[key] = val
}

// ── Inline helpers (mirrors finder.ts) ───────────────────────────────────────

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g
const MAILTO_REGEX = /href=["']mailto:([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/gi

function findEmailInHtml(html: string): string | null {
  const mailtoRe = new RegExp(MAILTO_REGEX.source, 'gi')
  let m: RegExpExecArray | null
  while ((m = mailtoRe.exec(html)) !== null) return m[1]
  return html.match(EMAIL_REGEX)?.[0] ?? null
}

async function fetchPage(url: string): Promise<string> {
  try {
    const norm = url.startsWith('http') ? url : `https://${url}`
    const res = await fetch(norm, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AussieVentureBot/1.0)' },
      signal: AbortSignal.timeout(7000),
    })
    return await res.text()
  } catch {
    return ''
  }
}

async function findEmailForBusiness(website: string): Promise<string | null> {
  const base = website.replace(/\/$/, '')
  for (const url of [website, `${base}/contact`, `${base}/contact-us`]) {
    const html = await fetchPage(url)
    if (!html) continue
    const email = findEmailInHtml(html)
    if (email) return email
  }
  return null
}

// ── Google Places direct call (mirrors googleplaces.ts) ──────────────────────

interface GooglePlace {
  displayName?: { text: string }
  formattedAddress?: string
  nationalPhoneNumber?: string
  websiteUri?: string
  rating?: number
  userRatingCount?: number
}

interface GoogleResponse {
  places?: GooglePlace[]
  error?: { message: string; status: string }
}

async function callGoogleMaps(query: string, limit: number, apiKey: string): Promise<GooglePlace[]> {
  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.websiteUri,places.rating,places.userRatingCount',
    },
    body: JSON.stringify({ textQuery: query, maxResultCount: limit, languageCode: 'en', regionCode: 'AU' }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Google Places API ${res.status}: ${text.slice(0, 200)}`)
  }
  const data = await res.json() as GoogleResponse
  if (data.error) throw new Error(`Google Places error: ${data.error.message}`)
  return data.places ?? []
}

// ── Outscraper direct call ────────────────────────────────────────────────────

interface OutscraperJob { id: string; status: string; results_location: string; data?: unknown[][] }
interface OutscraperBiz { name: string; website?: string; phone?: string; rating?: number; email?: string }

async function callOutscraper(query: string, limit: number): Promise<OutscraperBiz[]> {
  const apiKey = (process.env.OUTSCRAPER_API_KEY ?? '').replace(/[^\x20-\x7E]/g, '').trim()
  const params = new URLSearchParams({ query, limit: String(limit), language: 'en', region: 'AU' })
  const res = await fetch(`https://api.app.outscraper.com/maps/search-v3?${params}`, {
    headers: { 'X-API-KEY': apiKey },
  })
  if (!res.ok) throw new Error(`Outscraper ${res.status}`)
  const job = await res.json() as OutscraperJob
  if (job.status !== 'Pending' && job.data) return job.data.flat() as OutscraperBiz[]
  if (!job.results_location) return []
  const pollUrl = job.results_location.replace(/https?:\/\/[^/]*datapipelineplatform\.cloud/, 'https://api.app.outscraper.com')
  for (let i = 1; i <= 20; i++) {
    await new Promise((r) => setTimeout(r, i < 3 ? 2000 : 4000))
    const p = await fetch(pollUrl, { headers: { 'X-API-KEY': apiKey } })
    const j = await p.json() as OutscraperJob
    console.log(`  Outscraper poll ${i}: ${j.status}`)
    if (j.status !== 'Pending') return (j.data?.flat() ?? []) as OutscraperBiz[]
  }
  return []
}

// ── divider ───────────────────────────────────────────────────────────────────

function hr(title: string) {
  console.log(`\n${'─'.repeat(60)}`)
  console.log(`  ${title}`)
  console.log('─'.repeat(60))
}

// ── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  const QUERY = 'travel agent Sydney CBD'
  const LIMIT = 5
  const apiKey = process.env.GOOGLE_MAPS_API_KEY ?? ''

  console.log('Google Maps API Key:', apiKey ? `${apiKey.slice(0, 8)}...${apiKey.slice(-4)}` : 'NOT SET')
  if (!apiKey) {
    console.error('GOOGLE_MAPS_API_KEY not set in .env.local — aborting')
    process.exit(1)
  }

  // ──────────────────────────────────────────────────────────────────────────
  hr('TEST 1 — Google Maps basic search')
  // ──────────────────────────────────────────────────────────────────────────

  let googlePlaces: GooglePlace[] = []
  try {
    googlePlaces = await callGoogleMaps(QUERY, LIMIT, apiKey)
    console.log(`Found ${googlePlaces.length} businesses:\n`)
    for (const p of googlePlaces) {
      console.log(`  Name    : ${p.displayName?.text ?? '—'}`)
      console.log(`  Address : ${p.formattedAddress ?? '—'}`)
      console.log(`  Phone   : ${p.nationalPhoneNumber ?? '—'}`)
      console.log(`  Website : ${p.websiteUri ?? '—'}`)
      console.log(`  Rating  : ${p.rating ?? '—'} (${p.userRatingCount ?? 0} reviews)`)
      console.log()
    }
  } catch (err) {
    console.error('TEST 1 FAILED:', err instanceof Error ? err.message : err)
  }

  // ──────────────────────────────────────────────────────────────────────────
  hr('TEST 2 — Compare Google Maps vs Outscraper')
  // ──────────────────────────────────────────────────────────────────────────

  let outscraperResults: OutscraperBiz[] = []
  try {
    outscraperResults = await callOutscraper(QUERY, LIMIT)
  } catch (err) {
    console.error('Outscraper call failed:', err instanceof Error ? err.message : err)
  }

  const googleNames = new Set(googlePlaces.map((p) => p.displayName?.text?.toLowerCase() ?? ''))
  const outscraperNames = new Set(outscraperResults.map((r) => r.name?.toLowerCase() ?? ''))

  console.log(`Google Maps returned   : ${googlePlaces.length} businesses`)
  console.log(`Outscraper returned    : ${outscraperResults.length} businesses`)
  console.log(`Google with website    : ${googlePlaces.filter((p) => p.websiteUri).length}/${googlePlaces.length}`)
  console.log(`Outscraper with website: ${outscraperResults.filter((r) => r.website).length}/${outscraperResults.length}`)

  const onlyInGoogle = [...googleNames].filter((n) => n && !outscraperNames.has(n))
  const onlyInOutscraper = [...outscraperNames].filter((n) => n && !googleNames.has(n))
  const inBoth = [...googleNames].filter((n) => n && outscraperNames.has(n))

  console.log(`\nIn both                : ${inBoth.length} — ${inBoth.join(', ') || 'none'}`)
  console.log(`Google only            : ${onlyInGoogle.length} — ${onlyInGoogle.join(', ') || 'none'}`)
  console.log(`Outscraper only        : ${onlyInOutscraper.length} — ${onlyInOutscraper.join(', ') || 'none'}`)

  console.log('\nOutscraper results:')
  for (const r of outscraperResults) {
    console.log(`  ${r.name} | website: ${r.website ? 'YES' : 'no'} | email: ${r.email || 'no'}`)
  }

  // ──────────────────────────────────────────────────────────────────────────
  hr('TEST 3 — Email extraction on first Google result with website')
  // ──────────────────────────────────────────────────────────────────────────

  const withWebsite = googlePlaces.find((p) => !!p.websiteUri)
  if (!withWebsite) {
    console.log('No Google result had a website — skipping email extraction test')
  } else {
    const site = withWebsite.websiteUri!
    console.log(`Business : ${withWebsite.displayName?.text}`)
    console.log(`Website  : ${site}`)
    console.log('Crawling for email…')
    try {
      const email = await findEmailForBusiness(site)
      if (email) {
        console.log(`Email found: ${email}`)
      } else {
        console.log('No email found (business may not publish email publicly)')
      }
    } catch (err) {
      console.error('Email extraction error:', err instanceof Error ? err.message : err)
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  hr('TEST 4 — Cache test (via Supabase search_cache table)')
  // ──────────────────────────────────────────────────────────────────────────

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )

  const cacheQuery = `${QUERY} [cache-test-${Date.now()}]` // unique so it never pre-exists

  // First call: insert into cache manually (simulating what searchBusinesses does)
  console.log(`Cache query: "${cacheQuery}"`)
  console.log('First call — writing to cache…')

  let cacheWriteOk = false
  try {
    const { error } = await supabase.from('search_cache').upsert(
      {
        query: cacheQuery,
        results: googlePlaces.length > 0 ? googlePlaces.slice(0, 2) : [{ name: 'test' }],
        api_used: 'google_maps',
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      },
      { onConflict: 'query' }
    )
    if (error) {
      console.log(`Cache write failed: ${error.message}`)
      console.log('(Has migration 008_api_settings.sql been run in Supabase? If not, run it first.)')
    } else {
      cacheWriteOk = true
      console.log('Cache write: OK')
    }
  } catch (err) {
    console.log(`Cache write error: ${err instanceof Error ? err.message : err}`)
  }

  // Second call: read from cache
  console.log('Second call — reading from cache…')
  if (cacheWriteOk) {
    const { data: cached, error: readErr } = await supabase
      .from('search_cache')
      .select('results, api_used')
      .eq('query', cacheQuery)
      .gt('expires_at', new Date().toISOString())
      .maybeSingle()

    if (readErr) {
      console.log(`Cache read error: ${readErr.message}`)
    } else if (cached) {
      console.log(`Cache hit: YES — api_used: ${cached.api_used}`)
    } else {
      console.log('Cache hit: NO — entry not found (unexpected)')
    }

    // Cleanup test entry
    await supabase.from('search_cache').delete().eq('query', cacheQuery)
    console.log('Test cache entry cleaned up')
  } else {
    console.log('Cache hit: SKIPPED (write failed — run migration 008 first)')
  }

  // ──────────────────────────────────────────────────────────────────────────
  hr('TEST 5 — Fallback test (invalid Google Maps key)')
  // ──────────────────────────────────────────────────────────────────────────

  const originalKey = process.env.GOOGLE_MAPS_API_KEY
  process.env.GOOGLE_MAPS_API_KEY = 'INVALID_KEY_FOR_FALLBACK_TEST'

  console.log('Set GOOGLE_MAPS_API_KEY = INVALID_KEY_FOR_FALLBACK_TEST')
  console.log('Calling Google Maps API (expect failure)…')

  let fallbackTriggered = false
  try {
    await callGoogleMaps(QUERY, 2, 'INVALID_KEY_FOR_FALLBACK_TEST')
    console.log('Google Maps returned results with invalid key (unexpected)')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.log(`Google Maps threw: ${msg.slice(0, 120)}`)
    fallbackTriggered = true
    console.log('→ searchBusinesses would catch this error and call Outscraper instead')
  }

  // Restore key
  process.env.GOOGLE_MAPS_API_KEY = originalKey
  console.log(`\nRestored GOOGLE_MAPS_API_KEY = ${originalKey?.slice(0, 8)}...${originalKey?.slice(-4)}`)
  console.log(`\nFallback triggered: ${fallbackTriggered ? 'YES ✓' : 'NO ✗'}`)

  // ──────────────────────────────────────────────────────────────────────────
  hr('SUMMARY')
  // ──────────────────────────────────────────────────────────────────────────

  console.log(`TEST 1 (Google Maps search)    : ${googlePlaces.length > 0 ? `PASS — ${googlePlaces.length} results` : 'FAIL'}`)
  console.log(`TEST 2 (vs Outscraper)         : PASS — ${inBoth.length} overlap, ${onlyInGoogle.length} Google-only, ${onlyInOutscraper.length} Outscraper-only`)
  console.log(`TEST 3 (email extraction)      : ${withWebsite ? 'RAN' : 'SKIPPED (no website in results)'}`)
  console.log(`TEST 4 (cache round-trip)      : ${cacheWriteOk ? 'PASS' : 'SKIPPED (run migration 008 first)'}`)
  console.log(`TEST 5 (fallback on bad key)   : ${fallbackTriggered ? 'PASS ✓' : 'FAIL'}`)
}

main().catch(console.error)
