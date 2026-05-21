/**
 * test-finder.ts
 *
 * Validates real Google Maps results through:
 *   - normalizeDomain()
 *   - early duplicate detection (against DB + session)
 *   - global lead filtering (keywords + categories)
 *
 * Does NOT scrape websites, crawl pages, or extract emails.
 * Run: npm run test:finder
 */

import * as dotenv from 'dotenv'
import * as path from 'path'
import { createClient } from '@supabase/supabase-js'

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') })

// ── Config ────────────────────────────────────────────────────────────────────

const TEST_QUERY =  "halal restaurants Bankstown NSW Australia";
const LIMIT = 20

// ── normalizeDomain (mirrors finder.ts) ───────────────────────────────────────

function normalizeDomain(url: string): string | null {
  try {
    const withProtocol = /^https?:\/\//i.test(url) ? url : `https://${url}`
    const parsed = new URL(withProtocol)
    return parsed.hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return null
  }
}

// ── Google Places (production API, mirrors googleplaces.ts) ───────────────────

interface GooglePlace {
  displayName?: { text: string }
  formattedAddress?: string
  websiteUri?: string
}

interface GoogleSearchResponse {
  places?: GooglePlace[]
}

async function searchGoogle(query: string, limit: number): Promise<GooglePlace[]> {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY
  if (!apiKey) throw new Error('GOOGLE_MAPS_API_KEY not set in .env.local')

  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.websiteUri',
    },
    body: JSON.stringify({
      textQuery: query,
      maxResultCount: Math.min(20, limit),
      languageCode: 'en',
      regionCode: 'AU',
    }),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Google Places API ${res.status}: ${text.slice(0, 300)}`)
  }

  const data = await res.json() as GoogleSearchResponse
  return data.places ?? []
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('═'.repeat(60))
  console.log('  TEST-FINDER  —  no scraping, no emails')
  console.log(`  Query: "${TEST_QUERY}"`)
  console.log('═'.repeat(60))

  const googleKey = process.env.GOOGLE_MAPS_API_KEY
  if (!googleKey) {
    console.error('\n✗ GOOGLE_MAPS_API_KEY not set in .env.local — aborting')
    process.exit(1)
  }
  console.log(`\nGoogle Maps key : ${googleKey.slice(0, 8)}...${googleKey.slice(-4)}`)

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !supabaseKey) {
    console.error('✗ NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set — aborting')
    process.exit(1)
  }

  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  // ── Load filter settings from DB ─────────────────────────────────────────
  const [filterEnabledRow, blockedKeywordsRow] = await Promise.all([
    supabase.from('settings').select('value').eq('key', 'enable_lead_filtering').single(),
    supabase.from('settings').select('value').eq('key', 'blocked_business_keywords').single(),
  ])

  const leadFilterEnabled = filterEnabledRow.data?.value === 'true'
  const blockedKeywords: string[] = (() => {
    try { return JSON.parse(blockedKeywordsRow.data?.value ?? '[]') as string[] } catch { return [] }
  })()

  console.log(`Filter enabled  : ${leadFilterEnabled}`)
  console.log(`Blocked keywords: ${blockedKeywords.length ? blockedKeywords.join(', ') : '(none)'}`)

  // ── Load known domains from DB (all leads, all statuses) ─────────────────
  const { data: existingWebsiteRows } = await supabase
    .from('leads')
    .select('website')
    .not('website', 'is', null)

  const knownDomains = new Set<string>(
    (existingWebsiteRows ?? [])
      .map((r: { website: string | null }) => normalizeDomain(r.website ?? ''))
      .filter((d): d is string => Boolean(d))
  )
  console.log(`Known domains   : ${knownDomains.size} (from leads table)`)

  // Session-level dedup — tracks domains seen within this test run
  const seenDomains = new Set<string>()

  // ── Search ────────────────────────────────────────────────────────────────
  console.log(`\nCalling Google Maps API…\n`)
  let places: GooglePlace[]
  try {
    places = await searchGoogle(TEST_QUERY, LIMIT)
  } catch (err) {
    console.error('Google Maps search failed:', err instanceof Error ? err.message : err)
    process.exit(1)
  }

  console.log(`${places.length} result(s) returned`)
  console.log('─'.repeat(60))

  // ── Per-result processing ─────────────────────────────────────────────────
  let passCount = 0
  let blockedKeywordCount = 0
  let earlyDuplicateCount = 0

  for (const place of places) {
    const name = place.displayName?.text ?? '(unnamed)'
    const website = place.websiteUri ?? ''

    console.log(`\nBusiness : ${name}`)
    console.log(`Website  : ${website || '(none)'}`)

    // 1. Keyword filter — whole-word match only (avoids SNOWBAR, Barangaroo false positives)
    if (leadFilterEnabled && blockedKeywords.length > 0) {
      const nameWords = name.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean)
      const matchedKeyword = blockedKeywords.find((kw) => nameWords.includes(kw.toLowerCase()))
      if (matchedKeyword) {
        console.log(`[BLOCKED_KEYWORD] matched: "${matchedKeyword}"`)
        blockedKeywordCount++
        continue
      }
    }

    // 2. Early domain dedup
    if (website) {
      const domain = normalizeDomain(website)
      if (domain) {
        if (knownDomains.has(domain) || seenDomains.has(domain)) {
          const source = knownDomains.has(domain) ? 'known_in_db' : 'seen_this_run'
          console.log(`[EARLY_DUPLICATE] domain: ${domain} (${source})`)
          earlyDuplicateCount++
          continue
        }
        seenDomains.add(domain)
      }
    }

    console.log('[PASS]')
    passCount++
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n' + '─'.repeat(60))
  console.log('SUMMARY')
  console.log('─'.repeat(60))
  console.log(`Total             : ${places.length}`)
  console.log(`[PASS]            : ${passCount}`)
  console.log(`[BLOCKED_KEYWORD] : ${blockedKeywordCount}`)
  console.log(`[EARLY_DUPLICATE] : ${earlyDuplicateCount}`)

  if (!leadFilterEnabled) {
    console.log('\nNote: filtering is DISABLED in DB settings.')
    console.log('Enable it in the dashboard (Settings > Lead Filtering) to test keyword blocking.')
  }

  console.log()
}

main().catch((err) => {
  console.error('Fatal:', err instanceof Error ? err.message : err)
  process.exit(1)
})
