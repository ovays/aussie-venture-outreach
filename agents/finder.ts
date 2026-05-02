import { createServiceClient } from '@/lib/supabase/server'
import { searchBusinesses } from '@/lib/outscraper'

const EMAIL_REGEX = /[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}/gi
const INSTAGRAM_REGEX = /instagram\.com\/([a-zA-Z0-9_.]{3,30})/i
const INSTAGRAM_SKIP = new Set(['p', 'reel', 'reels', 'stories', 'explore', 'accounts', 'share', 'sharer'])

// Phase 1 categories in order (highest email rate first)
const EMAIL_CATEGORIES = [
  { name: 'Travel Agents',         query: 'travel agent Sydney' },
  { name: 'Hotels / Resorts',      query: 'hotel Sydney' },
  { name: 'Tour Operators',        query: 'tour operator Sydney' },
  { name: 'Spas / Massage Studios',query: 'day spa Sydney' },
  { name: 'Beauty / Lash Studios', query: 'beauty studio Sydney' },
  { name: 'Hair Salons',           query: 'hair salon Sydney' },
  { name: 'Halal Restaurants',     query: 'halal restaurant Sydney' },
  { name: 'Halal Cafes',           query: 'halal cafe Sydney' },
  { name: 'Halal Bakeries',        query: 'halal bakery Sydney' },
  { name: 'Nail Salons',           query: 'nail salon Sydney' },
]

// Phase 2 categories
const DM_CATEGORIES = [
  { name: 'Halal Restaurants', query: 'halal restaurant Sydney' },
  { name: 'Halal Cafes',       query: 'halal cafe Sydney' },
  { name: 'Halal Bakeries',    query: 'halal bakery Sydney' },
  { name: 'Nail Salons',       query: 'nail salon Sydney' },
]

async function fetchWebsiteText(url: string): Promise<string> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 5000)
  try {
    const normalised = url.startsWith('http') ? url : `https://${url}`
    const res = await fetch(normalised, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AussieVentureBot/1.0)' },
      signal: controller.signal,
    })
    clearTimeout(timeoutId)
    const html = await res.text()
    return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 6000)
  } catch {
    clearTimeout(timeoutId)
    return ''
  }
}

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

function extractInstagramHandle(text: string): string | null {
  const match = text.match(INSTAGRAM_REGEX)
  if (!match) return null
  const handle = match[1].toLowerCase()
  if (INSTAGRAM_SKIP.has(handle)) return null
  return `@${match[1]}`
}

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

  // Read quota targets from settings
  const [emailLimitRow, dmLimitRow, totalLimitRow] = await Promise.all([
    supabase.from('settings').select('value').eq('key', 'daily_email_limit').single(),
    supabase.from('settings').select('value').eq('key', 'daily_dm_limit').single(),
    supabase.from('settings').select('value').eq('key', 'daily_lead_limit').single(),
  ])

  const EMAIL_TARGET = parseInt(emailLimitRow.data?.value ?? '30', 10)
  const DM_TARGET = parseInt(dmLimitRow.data?.value ?? '10', 10)
  const TOTAL_TARGET = parseInt(totalLimitRow.data?.value ?? '40', 10)

  console.log(`[finder] Targets: ${EMAIL_TARGET} email, ${DM_TARGET} DM, ${TOTAL_TARGET} total`)

  let emailCount = 0
  let dmCount = 0
  let callCount = 0

  // Track businesses saved in Phase 1 to skip in Phase 2
  const phase1Names = new Set<string>()

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // PHASE 1 — EMAIL LEADS
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  console.log('\n[finder] ═══ PHASE 1: Email Leads ═══')

  for (const category of EMAIL_CATEGORIES) {
    if (emailCount >= EMAIL_TARGET) break
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
      if (emailCount >= EMAIL_TARGET) break
      if (emailCount + dmCount >= TOTAL_TARGET) break

      const name = result.name
      const website = result.website || null

      // Dedup check
      if (await isAlreadyInDB(supabase, name, 'Sydney', result.phone)) {
        console.log(`❌ Skip: ${name} — already in DB`)
        continue
      }

      // Check Outscraper email field first (free)
      let foundEmail: string | null = result.email || null
      let emailSource = 'outscraper'

      // If website is Instagram URL, note for Phase 2 and skip
      if (!foundEmail && website && INSTAGRAM_REGEX.test(website)) {
        const handle = extractInstagramHandle(website)
        if (handle) {
          console.log(`📌 Noted for Phase 2: ${name} → ${handle} (instagram from website URL)`)
        }
        continue
      }

      // Fetch website for email only if quota not yet filled
      if (!foundEmail && website && emailCount < EMAIL_TARGET) {
        const homeText = await fetchWebsiteText(website)
        if (homeText) {
          foundEmail = extractEmail(homeText)
          if (foundEmail) emailSource = 'homepage'
        }

        // Try /contact page once if still no email
        if (!foundEmail) {
          const base = website.startsWith('http') ? website : `https://${website}`
          const contactUrl = base.replace(/\/$/, '') + '/contact'
          const contactText = await fetchWebsiteText(contactUrl)
          if (contactText) {
            foundEmail = extractEmail(contactText)
            if (foundEmail) emailSource = 'contact'
          }
        }
      }

      if (foundEmail) {
        const { error } = await supabase.from('leads').insert({
          business_name: name,
          category_name: category.name,
          city: 'Sydney',
          state: 'NSW',
          phone: result.phone || null,
          email: foundEmail,
          website: website,
          address: result.full_address || null,
          google_rating: result.rating || null,
          google_reviews_count: result.reviews || null,
          status: 'new',
          outreach_channel: 'email',
        })

        if (error) {
          console.error(`[finder] Insert failed for "${name}": ${error.message}`)
          continue
        }

        emailCount++
        phase1Names.add(name)
        console.log(`✅ Email: ${name} → ${foundEmail} (source: ${emailSource})`)

        await supabase.from('activity_log').insert({
          event_type: 'lead_found',
          description: `Email lead: ${name} — ${foundEmail}`,
          metadata: { category: category.name, city: 'Sydney', email: foundEmail, source: emailSource, type: 'email' },
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

      const name = result.name
      const website = result.website || null

      // Skip if saved in Phase 1
      if (phase1Names.has(name)) continue

      // Dedup check against DB
      if (await isAlreadyInDB(supabase, name, 'Sydney', result.phone)) {
        console.log(`❌ Skip: ${name} — already in DB`)
        continue
      }

      // Find Instagram: check Outscraper fields then website field
      let instagramHandle: string | null = null

      // Check any instagram-like field in result
      const resultAny = result as unknown as Record<string, unknown>
      for (const key of ['instagram', 'instagram_handle', 'social_media']) {
        const val = resultAny[key]
        if (typeof val === 'string' && val) {
          instagramHandle = extractInstagramHandle(val) ?? (val.startsWith('@') ? val : `@${val}`)
          break
        }
      }

      // Check website field for instagram.com
      if (!instagramHandle && website && INSTAGRAM_REGEX.test(website)) {
        instagramHandle = extractInstagramHandle(website)
      }

      if (instagramHandle) {
        const { error } = await supabase.from('leads').insert({
          business_name: name,
          category_name: category.name,
          city: 'Sydney',
          state: 'NSW',
          phone: result.phone || null,
          email: null,
          website: website,
          address: result.full_address || null,
          instagram_handle: instagramHandle,
          google_rating: result.rating || null,
          google_reviews_count: result.reviews || null,
          status: 'new',
          outreach_channel: 'instagram',
        })

        if (error) {
          console.error(`[finder] Insert failed for "${name}": ${error.message}`)
          continue
        }

        dmCount++
        console.log(`📱 DM: ${name} → ${instagramHandle}`)

        await supabase.from('activity_log').insert({
          event_type: 'lead_found',
          description: `DM lead: ${name} — ${instagramHandle}`,
          metadata: { category: category.name, city: 'Sydney', instagram: instagramHandle, type: 'dm' },
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
    event_type: 'finder_complete',
    description: `Finder complete: ${emailCount} email leads, ${dmCount} DM leads (${callCount} searches)`,
    metadata: {
      email_leads: emailCount,
      dm_leads: dmCount,
      email_target: EMAIL_TARGET,
      dm_target: DM_TARGET,
      total_target: TOTAL_TARGET,
      outscraper_calls: callCount,
      estimated_cost: (callCount * 0.002).toFixed(4),
    },
  })

  return total
}
