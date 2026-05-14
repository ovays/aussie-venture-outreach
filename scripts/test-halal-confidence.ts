/**
 * Local ReachAgent halal search diagnostic.
 *
 * READ ONLY:
 * - no Trigger.dev
 * - no sends or DM queueing
 * - no pipeline mutations
 * - no search exhaustion writes
 * - no outreach table writes
 *
 * Usage:
 *   npm run test:halal -- "halal restaurant Bankstown" 20
 *   npm run test:halal -- "halal restaurant Bankstown" 20 --show-all
 */

import * as dotenv from 'dotenv'
import * as fs from 'fs'
import * as path from 'path'
import { createClient } from '@supabase/supabase-js'
import {
  HALAL_QUALIFICATION_THRESHOLD,
  scoreHalalQualification,
} from '../src/lib/halalQualification'
import { findEmailForBusiness } from '../agents/finder'

type Source = 'Google Maps' | 'Outscraper'

type BusinessResult = {
  source: Source
  name: string
  website: string
  email: string
  reviews: number
  reviewTexts: string[]
  categories: string[]
  rating: number
  address: string
}

type DedupeLead = {
  id: string
  business_name: string | null
  email: string | null
  status: string | null
}

type DuplicateDecision =
  | { duplicate: false }
  | {
      duplicate: true
      reason: 'DUPLICATE_EMAIL_SKIPPED' | 'DUPLICATE_DOMAIN_SKIPPED'
      match: {
        id: string
        businessName: string | null
        email: string
        status: string | null
      }
    }

type GooglePlace = {
  id?: string
  displayName?: { text?: string }
  formattedAddress?: string
  websiteUri?: string
  rating?: number
  userRatingCount?: number
  types?: string[]
}

type GoogleReview = {
  text?: {
    text?: string
  }
  originalText?: {
    text?: string
  }
}

type GoogleResponse = {
  places?: GooglePlace[]
}

type GooglePlaceDetailsResponse = {
  reviews?: GoogleReview[]
}

type OutscraperRaw = {
  name?: string
  address?: string
  full_address?: string
  site?: string
  website?: string
  email?: string
  rating?: number
  reviews?: number
  type?: string
  category?: string
  categories?: string[] | string
  subtypes?: string[] | string
  [key: string]: unknown
}

const DEFAULT_QUERY = 'halal restaurant Bankstown'
const DEFAULT_LIMIT = 10
const DISPLAY_THRESHOLD = HALAL_QUALIFICATION_THRESHOLD
const GOOGLE_TEXT_SEARCH_ENDPOINT = 'https://places.googleapis.com/v1/places:searchText'
const GOOGLE_TEXT_SEARCH_FIELD_MASK = [
  'places.displayName',
  'places.formattedAddress',
  'places.websiteUri',
  'places.rating',
  'places.userRatingCount',
  'places.types',
  'places.id',
].join(',')
const GOOGLE_PLACE_DETAILS_FIELD_MASK = 'reviews'
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g
const MAILTO_REGEX = /href=["']mailto:([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/gi
const DEDUPE_STATUSES = ['new', 'researched', 'email_ready', 'contacted', 'followup_pending', 'followup_sent']
const MULTI_PART_PUBLIC_SUFFIXES = new Set(['com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'co.nz', 'co.uk'])


function loadEnv() {
  const envPath = path.resolve(process.cwd(), '.env.local')
  if (fs.existsSync(envPath)) dotenv.config({ path: envPath })
  else dotenv.config()
}

function parseArgs() {
  const args = process.argv.slice(2)
  const showAll = args.includes('--show-all')
  const positional = args.filter((arg) => arg !== '--show-all')
  const query = positional[0]?.trim() || DEFAULT_QUERY
  const parsedLimit = Number.parseInt(positional[1] ?? '', 10)
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : DEFAULT_LIMIT
  return { query, limit: Math.min(limit, 50), showAll }
}

function createReadOnlySupabaseClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !key) throw new Error('Supabase URL/key is not configured')
  return createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  })
}

async function searchGoogleMaps(query: string, limit: number): Promise<BusinessResult[]> {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY
  if (!apiKey) throw new Error('GOOGLE_MAPS_API_KEY is not set')

  console.log(`Google endpoint: ${GOOGLE_TEXT_SEARCH_ENDPOINT}`)
  console.log(`Google field mask: ${GOOGLE_TEXT_SEARCH_FIELD_MASK}`)

  const response = await fetch(GOOGLE_TEXT_SEARCH_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': GOOGLE_TEXT_SEARCH_FIELD_MASK,
    },
    body: JSON.stringify({
      textQuery: query,
      maxResultCount: Math.min(limit, 20),
      languageCode: 'en',
      regionCode: 'AU',
    }),
  })

  if (!response.ok) {
    throw new Error(`Google Maps API ${response.status}: ${(await response.text()).slice(0, 300)}`)
  }

  const data = await response.json() as GoogleResponse
  const places = data.places ?? []
  const results: BusinessResult[] = []

  for (const place of places) {
    results.push({
      source: 'Google Maps',
      name: place.displayName?.text ?? 'Unknown business',
      website: place.websiteUri ?? '',
      email: '',
      reviews: place.userRatingCount ?? 0,
      reviewTexts: place.id ? await fetchGooglePlaceReviewTexts(place.id, apiKey) : [],
      categories: place.types ?? [],
      rating: place.rating ?? 0,
      address: place.formattedAddress ?? '',
    })
  }

  return results
}

async function fetchGooglePlaceReviewTexts(placeId: string, apiKey: string): Promise<string[]> {
  const normalizedPlaceId = placeId.replace(/^places\//, '')
  const endpoint = `https://places.googleapis.com/v1/places/${encodeURIComponent(normalizedPlaceId)}`
  console.log(`Google details endpoint: ${endpoint}`)
  console.log(`Google details field mask: ${GOOGLE_PLACE_DETAILS_FIELD_MASK}`)

  try {
    const response = await fetch(endpoint, {
      headers: {
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': GOOGLE_PLACE_DETAILS_FIELD_MASK,
      },
    })

    if (!response.ok) {
      console.log(`Google details reviews unavailable for ${placeId}: ${response.status} ${(await response.text()).slice(0, 160)}`)
      return []
    }

    const details = await response.json() as GooglePlaceDetailsResponse
    return extractGoogleReviewTexts(details.reviews ?? [])
  } catch (error) {
    console.log(`Google details reviews unavailable for ${placeId}: ${error instanceof Error ? error.message : String(error)}`)
    return []
  }
}

async function searchOutscraper(query: string, limit: number): Promise<BusinessResult[]> {
  const apiKey = (process.env.OUTSCRAPER_API_KEY ?? '').replace(/[^\x20-\x7E]/g, '').trim()
  if (!apiKey) throw new Error('OUTSCRAPER_API_KEY is not set')

  const params = new URLSearchParams({
    query,
    limit: String(limit),
    language: 'en',
    region: 'AU',
  })
  const url = `https://api.app.outscraper.com/maps/search-v3?${params}`
  const headers = { 'X-API-KEY': apiKey }

  const response = await fetch(url, { headers })
  if (!response.ok) throw new Error(`Outscraper API ${response.status}: ${(await response.text()).slice(0, 300)}`)

  const job = await response.json() as {
    id: string
    status: string
    results_location?: string
    data?: OutscraperRaw[][]
  }

  let rows: OutscraperRaw[] = []
  if (job.status !== 'Pending' && job.data) {
    rows = job.data.flat()
  } else if (job.results_location) {
    const pollUrl = job.results_location.replace(
      /https?:\/\/[^/]*datapipelineplatform\.cloud/,
      'https://api.app.outscraper.com'
    )
    rows = await pollOutscraper(pollUrl, headers)
  }

  return rows.map((row) => ({
    source: 'Outscraper',
    name: row.name ?? 'Unknown business',
    website: String(row.website ?? row.site ?? ''),
    email: String(row.email ?? ''),
    reviews: Number(row.reviews ?? 0),
    reviewTexts: extractOutscraperReviewTexts(row),
    categories: normalizeCategories(row),
    rating: Number(row.rating ?? 0),
    address: String(row.full_address ?? row.address ?? ''),
  }))
}

async function pollOutscraper(url: string, headers: Record<string, string>): Promise<OutscraperRaw[]> {
  for (let attempt = 1; attempt <= 20; attempt++) {
    await sleep(attempt < 3 ? 2000 : 4000)
    const response = await fetch(url, { headers })
    if (!response.ok) throw new Error(`Outscraper poll ${response.status}`)
    const job = await response.json() as { status: string; data?: OutscraperRaw[][] }
    console.log(`Outscraper poll ${attempt}/20: ${job.status}`)
    if (job.status !== 'Pending') return job.data?.flat() ?? []
  }
  return []
}

function normalizeCategories(row: OutscraperRaw): string[] {
  const values = [row.category, row.type, row.categories, row.subtypes].flatMap((value) => {
    if (!value) return []
    if (Array.isArray(value)) return value.map(String)
    return String(value).split(',').map((item) => item.trim())
  })
  return [...new Set(values.filter(Boolean))]
}

function extractGoogleReviewTexts(reviews: GoogleReview[]): string[] {
  return [...new Set(reviews.flatMap((review) => [
    review.text?.text,
    review.originalText?.text,
  ]).filter(Boolean) as string[])]
}

function extractOutscraperReviewTexts(row: OutscraperRaw): string[] {
  const values = [
    row.reviews_data,
    row.reviews_data_clean,
    row.reviews_per_score,
    row.review_text,
    row.review,
  ]

  return values.flatMap(extractUnknownReviewText).filter(Boolean)
}

function extractUnknownReviewText(value: unknown): string[] {
  if (!value) return []
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(extractUnknownReviewText)
  if (typeof value !== 'object') return []

  const record = value as Record<string, unknown>
  return [
    record.text,
    record.review_text,
    record.original_text,
    record.originalText,
  ].flatMap(extractUnknownReviewText)
}

async function fetchWebsiteText(url: string): Promise<string> {
  if (!url) return ''
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 6000)
  try {
    const normalized = url.startsWith('http') ? url : `https://${url}`
    const response = await fetch(normalized, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ReachAgentLocalTest/1.0)' },
      signal: controller.signal,
    })
    const html = await response.text()
    return html.slice(0, 80_000)
  } catch {
    return ''
  } finally {
    clearTimeout(timeout)
  }
}

function extractEmail(text: string): string {
  const mailto = new RegExp(MAILTO_REGEX.source, 'gi')
  let match: RegExpExecArray | null
  while ((match = mailto.exec(text)) !== null) {
    if (isUsefulEmail(match[1])) return match[1].toLowerCase()
  }
  return (text.match(EMAIL_REGEX) ?? []).find(isUsefulEmail)?.toLowerCase() ?? ''
}

function isUsefulEmail(email: string): boolean {
  const lower = email.toLowerCase()
  return !lower.includes('@2x') && !/\.(png|jpe?g|gif|svg|webp|css|js|woff2?)$/i.test(lower)
}

async function loadDedupeLeads(): Promise<DedupeLead[]> {
  const supabase = createReadOnlySupabaseClient()
  const { data, error } = await supabase
    .from('leads')
    .select('id, business_name, email, status')
    .in('status', DEDUPE_STATUSES)
    .not('email', 'is', null)
    .order('created_at', { ascending: true })

  if (error) throw new Error(`Duplicate lookup failed: ${error.message}`)
  return (data ?? []) as DedupeLead[]
}

function checkDuplicate(email: string, leads: DedupeLead[]): DuplicateDecision {
  const normalized = normalizeEmail(email)
  if (!normalized) return { duplicate: false }

  const exact = leads.find((lead) => normalizeEmail(lead.email) === normalized)
  if (exact?.email) {
    return {
      duplicate: true,
      reason: 'DUPLICATE_EMAIL_SKIPPED',
      match: {
        id: exact.id,
        businessName: exact.business_name,
        email: normalizeEmail(exact.email) ?? exact.email,
        status: exact.status,
      },
    }
  }

  const rootDomain = extractRootDomain(normalized)
  if (!rootDomain) return { duplicate: false }

  const domainMatch = leads.find((lead) => extractRootDomain(lead.email) === rootDomain)
  if (!domainMatch?.email) return { duplicate: false }

  return {
    duplicate: true,
    reason: 'DUPLICATE_DOMAIN_SKIPPED',
    match: {
      id: domainMatch.id,
      businessName: domainMatch.business_name,
      email: normalizeEmail(domainMatch.email) ?? domainMatch.email,
      status: domainMatch.status,
    },
  }
}

function normalizeEmail(email: string | null | undefined): string | null {
  const normalized = email?.trim().toLowerCase()
  if (!normalized || !normalized.includes('@')) return null
  return normalized
}

function extractRootDomain(email: string | null | undefined): string | null {
  const normalized = normalizeEmail(email)
  const domain = normalized?.split('@')[1]?.replace(/\.+$/, '')
  if (!domain) return null

  const parts = domain.split('.').filter(Boolean)
  if (parts.length < 2) return null

  const suffix = parts.slice(-2).join('.')
  if (parts.length >= 3 && MULTI_PART_PUBLIC_SUFFIXES.has(suffix)) {
    return parts.slice(-3).join('.')
  }

  return parts.slice(-2).join('.')
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function main() {
  loadEnv()
  const { query, limit, showAll } = parseArgs()

  console.log('='.repeat(74))
  console.log('ReachAgent Local Halal Confidence Test')
  console.log('READ ONLY - no sends, no queues, no production writes')
  console.log('='.repeat(74))
  console.log(`Query: ${query}`)
  console.log(`Limit: ${limit}`)
  console.log(`Show all: ${showAll}`)

  const sourceStats: Record<Source, number> = { 'Google Maps': 0, Outscraper: 0 }
  let results: BusinessResult[] = []
  let googleRequests = 0
  let outscraperRequests = 0

  try {
    console.log('\nSearching Google Maps...')
    googleRequests++
    results = await searchGoogleMaps(query, limit)
    sourceStats['Google Maps'] = results.length
    console.log(`Google Maps returned ${results.length} result(s).`)
  } catch (error) {
    console.log(`Google Maps failed. Fallback reason: ${error instanceof Error ? error.message : String(error)}`)
  }

  if (!results.length) {
    console.log('\nSearching Outscraper fallback...')
    console.log('Fallback reason: Google Maps returned no usable results or failed before returning results.')
    outscraperRequests++
    try {
      results = await searchOutscraper(query, limit)
      sourceStats.Outscraper = results.length
      console.log(`Outscraper returned ${results.length} result(s).`)
    } catch (error) {
      console.log(`Outscraper fallback failed: ${error instanceof Error ? error.message : String(error)}`)
      results = []
    }
  }

  console.log('\nLoading existing lead emails for read-only duplicate display...')
  const dedupeLeads = await loadDedupeLeads()
  console.log(`Loaded ${dedupeLeads.length} existing pipeline email(s).`)

  let totalFiltered = 0
  let highConfidence = 0
  let duplicates = 0
  let displayed = 0

  for (const business of results.slice(0, limit)) {
const emailResult = business.website
  ? await findEmailForBusiness(business.website, business.name)
  : {
      email: '',
      websiteText: '',
    }

const websiteText = emailResult.websiteText || ''
const email = business.email || emailResult.email || ''
    const dedupe = email ? checkDuplicate(email, dedupeLeads) : { duplicate: false as const }
    const halal = scoreHalalQualification({
      name: business.name,
      categories: business.categories,
      websiteText,
      websiteUrl: business.website,
      reviewTexts: business.reviewTexts,
      reviews: business.reviews,
    })
    const filtered = halal.confidence < DISPLAY_THRESHOLD

    if (dedupe.duplicate) duplicates++
    if (halal.confidence >= 70) highConfidence++
    if (filtered) totalFiltered++

    if (filtered && !showAll) continue

    displayed++

    console.log('\n' + '='.repeat(74))
    console.log(business.name)
    console.log('='.repeat(74))
    console.log(`Source: ${business.source}`)
    console.log(`Website: ${business.website || 'N/A'}`)
    console.log(`Email: ${email || 'N/A'}`)
    console.log(`Duplicate: ${dedupe.duplicate}`)
    if (dedupe.duplicate) {
      console.log(`Duplicate Reason: ${dedupe.reason}`)
      console.log(`Existing Lead: ${dedupe.match.businessName ?? dedupe.match.id} (${dedupe.match.email})`)
    }
    console.log(`Rating: ${business.rating || 'N/A'} (${business.reviews} reviews)`)
    console.log(`Address: ${business.address || 'N/A'}`)
    console.log(`Categories: ${business.categories.length ? business.categories.join(', ') : 'N/A'}`)
    console.log(`Review Texts Analysed: ${business.reviewTexts.length}`)
    console.log(`\nHalal Confidence: ${halal.confidence}`)
    console.log(`Classification: ${halal.classification}`)

    console.log('\nReasons:')
    for (const reason of halal.reasons.length ? halal.reasons : ['no positive halal indicators found']) {
      console.log(`* ${reason}`)
    }

    if (halal.negativeSignals.length > 0) {
      console.log('\nNegative Signals:')
      for (const reason of halal.negativeSignals) {
        console.log(`* ${reason}`)
      }
    }

    if (filtered) {
      console.log('\nSKIPPED:')
      const skipReasons = [`confidence below ${DISPLAY_THRESHOLD}`, ...halal.negativeSignals]
      for (const reason of [...new Set(skipReasons)]) {
        console.log(`* ${reason}`)
      }
    }
  }

  console.log('\n' + '='.repeat(74))
  console.log('SUMMARY')
  console.log('='.repeat(74))
  console.log(`Total businesses searched: ${results.length}`)
  console.log(`Total filtered: ${totalFiltered}`)
  console.log(`Total displayed: ${displayed}`)
  console.log(`Total high confidence: ${highConfidence}`)
  console.log(`Total duplicates: ${duplicates}`)
  console.log(`Source usage: Google Maps=${sourceStats['Google Maps']}, Outscraper=${sourceStats.Outscraper}`)
  console.log(`Estimated API usage: Google Maps requests=${googleRequests}, Outscraper requests=${outscraperRequests}`)
  console.log('Database writes: 0')
}

main().catch((error) => {
  console.error('\nScript failed:', error instanceof Error ? error.message : String(error))
  process.exit(1)
})
