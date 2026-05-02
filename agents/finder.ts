import { createServiceClient } from '@/lib/supabase/server'
import { searchBusinesses } from '@/lib/outscraper'

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g
const MAILTO_REGEX = /href=["']mailto:([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/gi
const INSTAGRAM_REGEX = /instagram\.com\/([a-zA-Z0-9_.]{3,30})/i
const INSTAGRAM_SKIP = new Set(['p', 'reel', 'reels', 'stories', 'explore', 'accounts', 'share', 'sharer'])

// Phase 1 — first 4 categories are capped at EMAIL_TARGET/4 each to ensure variety
// Remaining categories fill whatever quota is left
const EMAIL_CATEGORIES = [
  { name: 'Travel Agents',          query: 'travel agent Sydney',     capped: true  },
  { name: 'Tour Operators',         query: 'tour operator Sydney',    capped: true  },
  { name: 'Boutique Hotels',        query: 'boutique hotel Sydney',   capped: true  },
  { name: 'Beauty / Lash Studios',  query: 'beauty studio Sydney',    capped: true  },
  { name: 'Hair Salons',            query: 'hair salon Sydney',       capped: false },
  { name: 'Spas / Massage Studios', query: 'day spa Sydney',          capped: false },
  { name: 'Halal Restaurants',      query: 'halal restaurant Sydney', capped: false },
]

const DM_CATEGORIES = [
  { name: 'Halal Restaurants', query: 'halal restaurant Sydney' },
  { name: 'Halal Cafes',       query: 'halal cafe Sydney' },
  { name: 'Halal Bakeries',    query: 'halal bakery Sydney' },
  { name: 'Nail Salons',       query: 'nail salon Sydney' },
]

// ── Email filtering ──────────────────────────────────────────────────────────

const BLOCKED_LOCALS = new Set([
  'noreply', 'donotreply', 'no-reply', 'wordpress',
  'postmaster', 'webmaster', 'bounce', 'mailer',
])

function isValidEmail(email: string): boolean {
  const local = email.toLowerCase().split('@')[0]
  if (BLOCKED_LOCALS.has(local)) return false
  if (local.length < 4) return false
  if (/\.(png|jpg|jpeg|gif|svg|webp|css|js|woff|ttf)$/i.test(email)) return false
  if (email.toLowerCase().includes('@2x')) return false
  // No vowels + no separators = random tracking ID (bg0i, ey6i, da7i)
  const hasVowel = /[aeiou]/.test(local)
  const hasSeparator = /[._]/.test(local)
  if (!hasVowel && !hasSeparator) return false
  // Short alphanumeric with a digit = generated tracking ID
  if (/^[a-z0-9]{2,6}$/.test(local) && /\d/.test(local)) return false
  return true
}

function findEmailInHtml(html: string): string | null {
  // Check mailto: links first — higher confidence than plain regex
  const mailtoRe = new RegExp(MAILTO_REGEX.source, 'gi')
  let m: RegExpExecArray | null
  while ((m = mailtoRe.exec(html)) !== null) {
    if (isValidEmail(m[1])) return m[1]
  }
  // Fall back to full-HTML regex scan (do NOT strip tags — emails live in <script> JSON-LD etc.)
  const matches = html.match(EMAIL_REGEX) ?? []
  return matches.find(isValidEmail) ?? null
}

// ── Website fetching ─────────────────────────────────────────────────────────

async function fetchHtml(url: string): Promise<string> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 5000)
  try {
    const normalised = url.startsWith('http') ? url : `https://${url}`
    const res = await fetch(normalised, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AussieVentureBot/1.0)' },
      signal: controller.signal,
    })
    clearTimeout(timeoutId)
    return await res.text()
  } catch {
    clearTimeout(timeoutId)
    return ''
  }
}

async function findEmailForBusiness(rawWebsite: string): Promise<{ email: string; source: string } | null> {
  let decoded: string
  try {
    decoded = decodeURIComponent(rawWebsite)
  } catch {
    decoded = rawWebsite
  }
  const base = decoded.replace(/\/$/, '')

  const pages = [
    { url: decoded,              label: 'homepage'     },
    { url: `${base}/contact`,    label: '/contact'     },
    { url: `${base}/contact-us`, label: '/contact-us'  },
    { url: `${base}/about`,      label: '/about'       },
    { url: `${base}/about-us`,   label: '/about-us'    },
  ]

  let fetches = 0
  for (const page of pages) {
    if (fetches >= 3) break
    const html = await fetchHtml(page.url)
    fetches++
    if (!html) continue
    const email = findEmailInHtml(html)
    if (email) return { email, source: page.label }
  }
  return null
}

// ── Irrelevant business filter ───────────────────────────────────────────────

const IRRELEVANT_KEYWORDS = [
  'migration', 'migrant', 'visa', 'immigration', 'education', 'university',
  'college', 'school', 'tafe', 'accounting', 'tax', 'legal', 'lawyer',
  'solicitor', 'dentist', 'doctor', 'medical', 'pharmacy', 'clinic',
  'real estate', 'mortgage', 'insurance', 'finance', 'funeral',
]

function isIrrelevant(name: string): boolean {
  const lower = name.toLowerCase()
  return IRRELEVANT_KEYWORDS.some((kw) => lower.includes(kw))
}

// ── DB dedup ─────────────────────────────────────────────────────────────────

async function isAlreadyInDB(
  supabase: ReturnType<typeof createServiceClient>,
  name: string,
  city: string,
  phone?: string
): Promise<boolean> {
  const conditions: string[] = [`and(business_name.eq.${name},city.eq.${city})`]
  if (phone) conditions.push(`phone.eq.${phone}`)
  const { data } = await supabase
    .from('leads')
    .select('id')
    .or(conditions.join(','))
    .limit(1)
  return !!data?.length
}

// ── Main agent ───────────────────────────────────────────────────────────────

export async function runFinderAgent(): Promise<number> {
  const supabase = createServiceClient()

  const { data: systemSetting } = await supabase
    .from('settings')
    .select('value')
    .eq('key', 'system_active')
    .single()

  if (systemSetting?.value !== 'true') {
    console.log('System is paused - Finder agent skipped')
    return 0
  }

  const [emailLimitRow, dmLimitRow, totalLimitRow] = await Promise.all([
    supabase.from('settings').select('value').eq('key', 'daily_email_limit').single(),
    supabase.from('settings').select('value').eq('key', 'daily_dm_limit').single(),
    supabase.from('settings').select('value').eq('key', 'daily_lead_limit').single(),
  ])

  const EMAIL_TARGET = parseInt(emailLimitRow.data?.value ?? '30', 10)
  const DM_TARGET    = parseInt(dmLimitRow.data?.value   ?? '10', 10)
  const TOTAL_TARGET = parseInt(totalLimitRow.data?.value ?? '40', 10)
  const cappedLimit  = Math.floor(EMAIL_TARGET / 4)

  console.log(`[finder] Targets: ${EMAIL_TARGET} email, ${DM_TARGET} DM, ${TOTAL_TARGET} total`)
  console.log(`[finder] Per-category cap (first 4): ${cappedLimit}`)

  let emailCount = 0
  let dmCount    = 0
  let callCount  = 0
  const phase1Names = new Set<string>()

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // PHASE 1 — EMAIL LEADS
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  console.log('\n[finder] ═══ PHASE 1: Email Leads ═══')

  for (const category of EMAIL_CATEGORIES) {
    if (emailCount >= EMAIL_TARGET) break
    if (emailCount + dmCount >= TOTAL_TARGET) break

    const categoryLimit = category.capped ? cappedLimit : EMAIL_TARGET - emailCount
    let categoryEmailCount = 0
    console.log(`\n[finder] Category: ${category.name} (limit: ${categoryLimit})`)

    let results
    try {
      callCount++
      results = await searchBusinesses(category.query, 50)
    } catch (error) {
      console.error(`[finder] Search error for "${category.query}":`, error)
      continue
    }

    for (const result of results) {
      if (emailCount >= EMAIL_TARGET) break
      if (emailCount + dmCount >= TOTAL_TARGET) break
      if (categoryEmailCount >= categoryLimit) break

      const name       = result.name
      const rawWebsite = result.website || null

      if (isIrrelevant(name)) {
        console.log(`❌ Skip: ${name} — irrelevant business type`)
        continue
      }

      if (await isAlreadyInDB(supabase, name, 'Sydney', result.phone)) {
        console.log(`❌ Skip: ${name} — already in DB`)
        continue
      }

      // If website is an Instagram URL → note for Phase 2 and skip
      if (rawWebsite && INSTAGRAM_REGEX.test(rawWebsite)) {
        const handle = extractInstagramHandle(rawWebsite)
        if (handle) console.log(`📌 Noted for Phase 2: ${name} → ${handle}`)
        continue
      }

      // Check Outscraper email field (free — no fetch needed)
      let foundEmail: string | null = null
      let emailSource = ''
      if (result.email && isValidEmail(result.email)) {
        foundEmail  = result.email
        emailSource = 'outscraper'
      }

      // Fetch website pages if no email yet
      if (!foundEmail && rawWebsite) {
        const found = await findEmailForBusiness(rawWebsite)
        if (found) {
          foundEmail  = found.email
          emailSource = found.source
        }
      }

      if (foundEmail) {
        const { error } = await supabase.from('leads').insert({
          business_name:        name,
          category_name:        category.name,
          city:                 'Sydney',
          state:                'NSW',
          phone:                result.phone  || null,
          email:                foundEmail,
          website:              rawWebsite,
          address:              result.address || null,
          google_rating:        result.rating  || null,
          google_reviews_count: result.reviews || null,
          status:               'new',
          outreach_channel:     'email',
        })

        if (error) {
          console.error(`[finder] Insert failed for "${name}": ${error.message}`)
          continue
        }

        emailCount++
        categoryEmailCount++
        phase1Names.add(name)
        console.log(`✅ Email: ${name} → ${foundEmail} (source: ${emailSource})`)

        await supabase.from('activity_log').insert({
          event_type:  'lead_found',
          description: `Email lead: ${name} — ${foundEmail}`,
          metadata:    { category: category.name, city: 'Sydney', email: foundEmail, source: emailSource, type: 'email' },
        })
      } else {
        console.log(`❌ Skip: ${name} — no email found`)
      }
    }
  }

  console.log(`\n[finder] Phase 1 complete: ${emailCount}/${EMAIL_TARGET} email leads`)

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // PHASE 2 — INSTAGRAM LEADS
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  console.log('\n[finder] ═══ PHASE 2: Instagram Leads ═══')

  for (const category of DM_CATEGORIES) {
    if (dmCount >= DM_TARGET) break
    if (emailCount + dmCount >= TOTAL_TARGET) break

    console.log(`\n[finder] Category: ${category.name}`)

    let results
    try {
      callCount++
      results = await searchBusinesses(category.query, 50)
    } catch (error) {
      console.error(`[finder] Search error for "${category.query}":`, error)
      continue
    }

    for (const result of results) {
      if (dmCount >= DM_TARGET) break
      if (emailCount + dmCount >= TOTAL_TARGET) break

      const name       = result.name
      const rawWebsite = result.website || null

      if (phase1Names.has(name)) continue

      if (await isAlreadyInDB(supabase, name, 'Sydney', result.phone)) {
        console.log(`❌ Skip: ${name} — already in DB`)
        continue
      }

      let instagramHandle: string | null = null

      // Check Outscraper social fields
      const resultAny = result as unknown as Record<string, unknown>
      for (const key of ['instagram', 'instagram_handle', 'social_media']) {
        const val = resultAny[key]
        if (typeof val === 'string' && val) {
          instagramHandle = extractInstagramHandle(val) ?? (val.startsWith('@') ? val : `@${val}`)
          break
        }
      }

      // Check if website field is an Instagram URL
      if (!instagramHandle && rawWebsite && INSTAGRAM_REGEX.test(rawWebsite)) {
        instagramHandle = extractInstagramHandle(rawWebsite)
      }

      if (instagramHandle) {
        const { error } = await supabase.from('leads').insert({
          business_name:        name,
          category_name:        category.name,
          city:                 'Sydney',
          state:                'NSW',
          phone:                result.phone  || null,
          email:                null,
          website:              rawWebsite,
          address:              result.address || null,
          instagram_handle:     instagramHandle,
          google_rating:        result.rating  || null,
          google_reviews_count: result.reviews || null,
          status:               'new',
          outreach_channel:     'instagram',
        })

        if (error) {
          console.error(`[finder] Insert failed for "${name}": ${error.message}`)
          continue
        }

        dmCount++
        console.log(`📱 DM: ${name} → ${instagramHandle}`)

        await supabase.from('activity_log').insert({
          event_type:  'lead_found',
          description: `DM lead: ${name} — ${instagramHandle}`,
          metadata:    { category: category.name, city: 'Sydney', instagram: instagramHandle, type: 'dm' },
        })
      } else {
        console.log(`❌ Skip: ${name} — no Instagram found`)
      }
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // SUMMARY
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  console.log(`\nPhase 1: ${emailCount}/${EMAIL_TARGET} email leads`)
  console.log(`Phase 2: ${dmCount}/${DM_TARGET} DM leads`)
  console.log(`Outscraper calls made: ${callCount}`)
  console.log(`Estimated cost: $${(callCount * 0.002).toFixed(4)}`)

  const total = emailCount + dmCount

  await supabase.from('activity_log').insert({
    event_type:  'finder_complete',
    description: `Finder complete: ${emailCount} email leads, ${dmCount} DM leads (${callCount} searches)`,
    metadata: {
      email_leads:      emailCount,
      dm_leads:         dmCount,
      email_target:     EMAIL_TARGET,
      dm_target:        DM_TARGET,
      total_target:     TOTAL_TARGET,
      outscraper_calls: callCount,
      estimated_cost:   (callCount * 0.002).toFixed(4),
    },
  })

  return total
}

function extractInstagramHandle(text: string): string | null {
  const match = text.match(INSTAGRAM_REGEX)
  if (!match) return null
  const handle = match[1].toLowerCase()
  if (INSTAGRAM_SKIP.has(handle)) return null
  return `@${match[1]}`
}
