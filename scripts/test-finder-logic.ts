/**
 * READ-ONLY diagnostic script — no database writes, no emails sent.
 * Tests Outscraper results + website email/Instagram extraction.
 * Run: npx tsx scripts/test-finder-logic.ts
 */

import * as dotenv from 'dotenv'
import * as fs from 'fs'
import * as path from 'path'

// Load .env.local
const envPath = path.resolve(process.cwd(), '.env.local')
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath })
} else {
  dotenv.config()
}

// ─── Outscraper ──────────────────────────────────────────────────────────────

interface RawOutscraperResult {
  name?: string
  full_address?: string
  phone?: string
  website?: string
  email?: string
  rating?: number
  reviews?: number
  // social fields Outscraper may return
  instagram?: string
  facebook?: string
  twitter?: string
  linkedin?: string
  [key: string]: unknown
}

async function searchOutscraper(query: string, limit: number): Promise<RawOutscraperResult[]> {
  const key = (process.env.OUTSCRAPER_API_KEY ?? '').replace(/[^\x20-\x7E]/g, '').trim()
  if (!key) throw new Error('OUTSCRAPER_API_KEY is not set')

  const params = new URLSearchParams({ query, limit: String(limit), language: 'en', region: 'AU' })
  const url = `https://api.app.outscraper.com/maps/search-v3?${params}`

  console.log(`\n🔍 Outscraper search: "${query}" (limit=${limit})`)
  console.log(`   URL: ${url}\n`)

  const res = await fetch(url, { headers: { 'X-API-KEY': key } })
  if (!res.ok) throw new Error(`Outscraper API error: ${res.status} ${await res.text()}`)

  const job = await res.json() as { id: string; status: string; results_location?: string; data?: RawOutscraperResult[][] }
  console.log(`   Job id=${job.id} status=${job.status}`)

  // Synchronous result
  if (job.status !== 'Pending' && job.data) {
    return job.data.flat()
  }

  // Poll for async result
  if (!job.results_location) throw new Error('No results_location in response')

  const pollUrl = job.results_location.replace(
    /https?:\/\/[^/]*datapipelineplatform\.cloud/,
    'https://api.app.outscraper.com'
  )

  for (let attempt = 1; attempt <= 20; attempt++) {
    await sleep(attempt < 3 ? 2000 : 4000)
    const pollRes = await fetch(pollUrl, { headers: { 'X-API-KEY': key } })
    const polled = await pollRes.json() as typeof job
    console.log(`   Poll ${attempt}: status=${polled.status}`)
    if (polled.status !== 'Pending') {
      return polled.data?.flat() ?? []
    }
  }

  throw new Error('Outscraper: max poll attempts reached')
}

// ─── Website fetch ───────────────────────────────────────────────────────────

async function fetchText(url: string): Promise<string> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 5000)
  try {
    const normalised = url.startsWith('http') ? url : `https://${url}`
    const res = await fetch(normalised, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ReachAgentBot/1.0)' },
      signal: controller.signal,
    })
    clearTimeout(timeoutId)
    const html = await res.text()
    return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 8000)
  } catch (err) {
    clearTimeout(timeoutId)
    return ''
  }
}

// ─── Extractors ──────────────────────────────────────────────────────────────

const EMAIL_REGEX = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g
const INSTAGRAM_REGEX = /instagram\.com\/([a-zA-Z0-9_.]{3,30})/i
const INSTAGRAM_SKIP = new Set(['p', 'reel', 'reels', 'stories', 'explore', 'accounts', 'share', 'sharer'])

function extractEmail(text: string): string | null {
  const matches = text.match(EMAIL_REGEX)
  if (!matches?.length) return null
  const valid = matches.filter(
    (e) =>
      !e.includes('noreply') &&
      !e.includes('no-reply') &&
      !e.includes('example') &&
      !e.includes('@2x') &&
      !/\.(png|jpg|jpeg|gif|svg|webp|css|js)$/i.test(e)
  )
  return valid[0] ?? null
}

function extractInstagram(text: string): string | null {
  const match = text.match(INSTAGRAM_REGEX)
  if (!match) return null
  const handle = match[1].toLowerCase()
  if (INSTAGRAM_SKIP.has(handle)) return null
  return `@${match[1]}`
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('═'.repeat(60))
  console.log('  FINDER LOGIC TEST — READ ONLY, NO DB WRITES')
  console.log('═'.repeat(60))

  // ── STEP 1: Outscraper search ──────────────────────────────────────────────
  const results = await searchOutscraper('nail salon Parramatta Sydney', 5)

  console.log(`\n${'─'.repeat(60)}`)
  console.log(`STEP 1 — Raw Outscraper results (${results.length} businesses)`)
  console.log('─'.repeat(60))

  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    console.log(`\n[${i + 1}] ${r.name}`)
    console.log(`    Address  : ${r.full_address ?? 'N/A'}`)
    console.log(`    Phone    : ${r.phone ?? 'N/A'}`)
    console.log(`    Email    : ${r.email ?? 'N/A'}`)
    console.log(`    Website  : ${r.website ?? 'N/A'}`)
    console.log(`    Rating   : ${r.rating ?? 'N/A'} (${r.reviews ?? 0} reviews)`)
    console.log(`    Instagram: ${r.instagram ?? 'N/A'}`)
    console.log(`    Facebook : ${r.facebook ?? 'N/A'}`)
    console.log(`    Twitter  : ${r.twitter ?? 'N/A'}`)
    console.log(`    LinkedIn : ${r.linkedin ?? 'N/A'}`)

    // Any extra fields Outscraper returned
    const known = new Set(['name', 'full_address', 'phone', 'website', 'email', 'rating', 'reviews',
      'instagram', 'facebook', 'twitter', 'linkedin', 'borough', 'city', 'postal_code',
      'country_code', 'latitude', 'longitude'])
    const extra = Object.entries(r).filter(([k, v]) => !known.has(k) && v != null && v !== '')
    if (extra.length) {
      console.log(`    Extra    : ${extra.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')}`)
    }
  }

  // ── STEP 2 & 3: Website enrichment ────────────────────────────────────────
  console.log(`\n${'─'.repeat(60)}`)
  console.log('STEP 2 — Website email extraction')
  console.log('─'.repeat(60))

  const stats = {
    emailFromOutscraper: 0,
    emailFromWebsite: 0,
    websiteButNoEmail: 0,
    noWebsite: 0,
    instagramFromOutscraper: 0,
    instagramFromWebsite: 0,
    totalEmail: 0,
    totalInstagram: 0,
  }

  const findings: Array<{
    name: string
    emailSource: string | null
    email: string | null
    instagramSource: string | null
    instagram: string | null
    contactable: boolean
  }> = []

  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    console.log(`\n[${i + 1}] ${r.name}`)

    let foundEmail: string | null = r.email || null
    let foundInstagram: string | null = (r.instagram as string) || null
    let emailSource: string | null = null
    let instagramSource: string | null = null

    if (foundEmail) {
      emailSource = 'outscraper'
      stats.emailFromOutscraper++
      console.log(`    ✅ Email from Outscraper: ${foundEmail}`)
    }

    if (foundInstagram) {
      instagramSource = 'outscraper'
      stats.instagramFromOutscraper++
      console.log(`    📱 Instagram from Outscraper: ${foundInstagram}`)
    }

    // Instagram-as-website detection
    if (!foundInstagram && r.website && /instagram\.com\/([a-zA-Z0-9_.]{3,30})/i.test(r.website)) {
      const m = r.website.match(/instagram\.com\/([a-zA-Z0-9_.]{3,30})/i)
      if (m) {
        foundInstagram = `@${m[1]}`
        instagramSource = 'website-url-is-instagram'
        stats.instagramFromWebsite++
        console.log(`    📱 Instagram-as-website: ${foundInstagram} (from ${r.website})`)
      }
    }

    const realWebsite = r.website && !r.website.includes('instagram.com') ? r.website : null

    if (!foundEmail && realWebsite) {
      // Fetch homepage
      console.log(`    🌐 Fetching homepage: ${realWebsite}`)
      const homepageText = await fetchText(realWebsite)

      if (homepageText) {
        const emailFromHome = extractEmail(homepageText)
        const instaFromHome = !foundInstagram ? extractInstagram(homepageText) : null

        if (emailFromHome) {
          foundEmail = emailFromHome
          emailSource = 'homepage'
          stats.emailFromWebsite++
          console.log(`    ✅ Email from homepage: ${emailFromHome}`)
        } else {
          console.log(`    ⚠️  No email on homepage`)

          // Try /contact page
          try {
            const base = new URL(realWebsite.startsWith('http') ? realWebsite : `https://${realWebsite}`)
            const contactUrl = `${base.origin}/contact`
            console.log(`    🌐 Fetching contact page: ${contactUrl}`)
            const contactText = await fetchText(contactUrl)

            if (contactText) {
              const emailFromContact = extractEmail(contactText)
              if (emailFromContact) {
                foundEmail = emailFromContact
                emailSource = '/contact page'
                stats.emailFromWebsite++
                console.log(`    ✅ Email from /contact: ${emailFromContact}`)
              } else {
                console.log(`    ❌ No email on /contact either`)
                stats.websiteButNoEmail++
              }

              if (!foundInstagram) {
                const instaFromContact = extractInstagram(contactText)
                if (instaFromContact) {
                  foundInstagram = instaFromContact
                  instagramSource = '/contact page'
                  stats.instagramFromWebsite++
                }
              }
            } else {
              console.log(`    ❌ /contact page unreachable`)
              stats.websiteButNoEmail++
            }
          } catch {
            stats.websiteButNoEmail++
          }
        }

        if (instaFromHome) {
          foundInstagram = instaFromHome
          instagramSource = 'homepage'
          stats.instagramFromWebsite++
          console.log(`    📱 Instagram from homepage: ${instaFromHome}`)
        }
      } else {
        console.log(`    ❌ Website unreachable (timeout or error)`)
        stats.websiteButNoEmail++
      }
    } else if (!foundEmail && !realWebsite) {
      // STEP 3
      stats.noWebsite++
      console.log(`    ⚠️  No website, no email`)
      if (foundInstagram) {
        console.log(`    📱 Instagram from Outscraper: ${foundInstagram}`)
      } else {
        console.log(`    ❌ No social links either`)
      }
    }

    if (foundEmail) stats.totalEmail++
    if (foundInstagram) stats.totalInstagram++

    findings.push({
      name: r.name ?? '?',
      emailSource,
      email: foundEmail,
      instagramSource,
      instagram: foundInstagram,
      contactable: !!(foundEmail || foundInstagram),
    })
  }

  // ── STEP 4: Summary ────────────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(60)}`)
  console.log('STEP 4 — Summary')
  console.log('═'.repeat(60))
  console.log(`\nOut of ${results.length} businesses:`)
  console.log(`  - ${stats.emailFromOutscraper} had email directly from Outscraper`)
  console.log(`  - ${stats.emailFromWebsite} had email found from website`)
  console.log(`  - ${stats.websiteButNoEmail} had website but no email found`)
  console.log(`  - ${stats.noWebsite} had no website at all`)
  console.log(`  - ${stats.instagramFromOutscraper + stats.instagramFromWebsite} had Instagram handle (${stats.instagramFromOutscraper} from Outscraper, ${stats.instagramFromWebsite} from website)`)
  console.log(`\nTotal contactable: ${stats.totalEmail} (email) + ${stats.totalInstagram} (Instagram)`)

  console.log(`\n${'─'.repeat(60)}`)
  console.log('Per-business result:')
  for (const f of findings) {
    const icon = f.email ? '✅' : f.instagram ? '📱' : '❌'
    const contact = f.email
      ? `email: ${f.email} (${f.emailSource})`
      : f.instagram
      ? `instagram: ${f.instagram} (${f.instagramSource})`
      : 'no contact found'
    console.log(`  ${icon} ${f.name} — ${contact}`)
  }

  console.log(`\n${'═'.repeat(60)}\n`)
}

main().catch((err) => {
  console.error('Script error:', err)
  process.exit(1)
})
