import { createServiceClient } from '@/lib/supabase/server'
import { searchBusinesses, type OutscraperResult } from '@/lib/searchBusinesses'
import { logger } from '@/lib/logger'

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g
const MAILTO_REGEX = /href=["']mailto:([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/gi
const INSTAGRAM_REGEX = /instagram\.com\/([a-zA-Z0-9_.]{3,30})/i
const INSTAGRAM_SKIP = new Set(['p', 'reel', 'reels', 'stories', 'explore', 'accounts', 'share', 'sharer'])

// Phase 1 — first 4 categories are capped at EMAIL_TARGET/4 each to ensure variety
// Remaining categories fill whatever quota is left
// {city} is replaced at runtime with the active suburb being searched
const EMAIL_CATEGORIES = [
  // High yield — search first, larger batch
  { name: 'Travel Agents',          query: 'travel agent {city}',     capped: true,  batchSize: 5 },
  { name: 'Tour Operators',         query: 'tour operator {city}',    capped: true,  batchSize: 5 },
  // Medium yield
  { name: 'Boutique Hotels',        query: 'boutique hotel {city}',   capped: true,  batchSize: 3 },
  { name: 'Beauty / Lash Studios',  query: 'beauty studio {city}',    capped: true,  batchSize: 3 },
  // Low yield — only reached if quota not filled
  { name: 'Hair Salons',            query: 'hair salon {city}',       capped: false, batchSize: 3 },
  { name: 'Spas / Massage Studios', query: 'day spa {city}',          capped: false, batchSize: 3 },
  { name: 'Halal Restaurants',      query: 'halal restaurant {city}', capped: false, batchSize: 3 },
]

// DM categories: leads queued for manual Instagram outreach (no Outscraper)
const DM_CATEGORY_NAMES = ['Halal Restaurants', 'Halal Cafes', 'Halal Bakeries', 'Nail Salons']

const CITY_STATE: Record<string, string> = {
  Sydney:    'NSW',
  Melbourne: 'VIC',
  Brisbane:  'QLD',
  Perth:     'WA',
  Adelaide:  'SA',
}

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
  const hasVowel = /[aeiou]/.test(local)
  const hasSeparator = /[._]/.test(local)
  if (!hasVowel && !hasSeparator) return false
  if (/^[a-z0-9]{2,6}$/.test(local) && /\d/.test(local)) return false
  return true
}

function findEmailInHtml(html: string): string | null {
  // Always check mailto: links FIRST — highest confidence
  const mailtoRe = new RegExp(MAILTO_REGEX.source, 'gi')
  let m: RegExpExecArray | null
  while ((m = mailtoRe.exec(html)) !== null) {
    if (isValidEmail(m[1])) return m[1]
  }
  // Only fall back to full-HTML regex if no mailto found
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
  'migrate', 'migration', 'migrant', 'visa', 'immigration', 'education', 'university',
  'college', 'school', 'tafe', 'accounting', 'tax', 'legal', 'lawyer',
  'solicitor', 'dentist', 'doctor', 'medical', 'pharmacy', 'clinic',
  'real estate', 'mortgage', 'insurance', 'finance', 'funeral',
]

function isIrrelevant(name: string): boolean {
  const lower = name.toLowerCase()
  return IRRELEVANT_KEYWORDS.some((kw) => lower.includes(kw))
}

// ── Business email quality filter ────────────────────────────────────────────

function isValidBusinessEmail(email: string, businessName: string): boolean {
  const domain = email.split('@')[1]?.toLowerCase() ?? ''
  const local  = email.split('@')[0]?.toLowerCase() ?? ''

  void businessName // reserved for future name-match heuristics

  const junkDomains = ['sentry.io', 'wixpress.com', 'mailchimp.com', 'sendgrid.net', 'example.com', 'domain.com', 'mail.com']
  if (junkDomains.some((d) => domain.includes(d))) return false

  const placeholders = ['example@', 'user@', 'test@', 'demo@', 'sample@']
  if (placeholders.some((p) => email.startsWith(p))) return false

  // Reject hex/random local parts (e.g. sentry error IDs)
  if (/^[a-f0-9]{20,}$/.test(local)) return false

  if (!domain.includes('.')) return false

  return true
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

// ── Daily spend helper ───────────────────────────────────────────────────────

async function getDailyOutscraperSpend(supabase: ReturnType<typeof createServiceClient>): Promise<number> {
  // Compute midnight Sydney time as a UTC timestamp.
  // The server (Trigger.dev) runs in UTC — using toISOString().slice(0,10) gives the UTC
  // date which can be yesterday in Sydney (UTC+10/+11), causing false "already spent" reads.
  const now = new Date()
  const sydneyDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(now)
  // Dynamic offset handles both AEST (+10) and AEDT (+11)
  const offsetMs =
    new Date(now.toLocaleString('en-US', { timeZone: 'Australia/Sydney' })).getTime() -
    new Date(now.toLocaleString('en-US', { timeZone: 'UTC' })).getTime()
  // Midnight Sydney expressed as UTC: take midnight of the Sydney date string (as UTC) then subtract the offset
  const todayStart = new Date(new Date(`${sydneyDate}T00:00:00Z`).getTime() - offsetMs)

  const { data } = await supabase
    .from('activity_log')
    .select('metadata')
    .eq('event_type', 'finder_complete')
    .gte('created_at', todayStart.toISOString())

  return (data ?? []).reduce((sum, row) => {
    const meta = row.metadata as { estimated_cost?: string | number } | null
    const cost = typeof meta?.estimated_cost === 'string'
      ? parseFloat(meta.estimated_cost)
      : typeof meta?.estimated_cost === 'number'
        ? meta.estimated_cost
        : 0
    return sum + (isNaN(cost) ? 0 : cost)
  }, 0)
}

// ── DM Queue cleanup ─────────────────────────────────────────────────────────

async function cleanupDmQueue(supabase: ReturnType<typeof createServiceClient>): Promise<void> {
  logger.info('finder', 'Cleaning up DM queue entries')

  const { error: fbErr } = await supabase.from('dm_queue').delete().eq('platform', 'facebook')
  if (fbErr) logger.error('finder', 'DM cleanup Facebook delete error', { error: fbErr.message })

  const invalidValues = ['Not found', 'Not mentioned', 'N/A', 'None', 'null', 'Unknown']
  for (const val of invalidValues) {
    await supabase.from('dm_queue').delete().eq('handle', val)
  }

  // Remove duplicate lead entries — keep oldest per lead_id
  const { data: allDms } = await supabase
    .from('dm_queue')
    .select('id, lead_id, created_at')
    .order('created_at', { ascending: true })

  if (allDms?.length) {
    const seenLeadIds = new Map<string, string>()
    const toDelete: string[] = []
    for (const dm of allDms) {
      if (seenLeadIds.has(dm.lead_id)) {
        toDelete.push(dm.id)
      } else {
        seenLeadIds.set(dm.lead_id, dm.id)
      }
    }
    if (toDelete.length) {
      logger.info('finder', `Removing ${toDelete.length} duplicate DM queue entries`)
      await supabase.from('dm_queue').delete().in('id', toDelete)
    } else {
      logger.info('finder', 'DM queue clean — no duplicates')
    }
  }
}

// ── Main agent ───────────────────────────────────────────────────────────────

export async function runFinderAgent(): Promise<number> {
  const supabase = createServiceClient()

  try {
  const { data: systemSetting } = await supabase
    .from('settings')
    .select('value')
    .eq('key', 'system_active')
    .single()

  if (systemSetting?.value !== 'true') {
    logger.info('finder', 'System paused - skipped')
    return 0
  }

  const [emailLimitRow, dmLimitRow, totalLimitRow, dailyOutscraperLimitRow] = await Promise.all([
    supabase.from('settings').select('value').eq('key', 'daily_email_limit').single(),
    supabase.from('settings').select('value').eq('key', 'daily_dm_limit').single(),
    supabase.from('settings').select('value').eq('key', 'daily_lead_limit').single(),
    supabase.from('settings').select('value').eq('key', 'daily_outscraper_limit').single(),
  ])

  const DAILY_EMAIL_LIMIT      = parseInt(emailLimitRow.data?.value ?? '30', 10)
  const DAILY_DM_LIMIT         = parseInt(dmLimitRow.data?.value   ?? '10', 10)
  const TOTAL_TARGET           = parseInt(totalLimitRow.data?.value ?? '40', 10)
  const EMAIL_TARGET           = Math.min(DAILY_EMAIL_LIMIT, TOTAL_TARGET)
  const DM_TARGET              = Math.min(DAILY_DM_LIMIT, Math.max(0, TOTAL_TARGET - EMAIL_TARGET))
  const DAILY_OUTSCRAPER_LIMIT = parseFloat(dailyOutscraperLimitRow.data?.value ?? '1.00')
  const cappedLimit            = EMAIL_TARGET > 0 ? Math.max(1, Math.ceil(EMAIL_TARGET / 4)) : 0

  logger.info('finder', 'Targets', { emailTarget: EMAIL_TARGET, dmTarget: DM_TARGET, totalTarget: TOTAL_TARGET })
  logger.info('finder', '[NEW_OUTREACH_ALLOCATION]', {
    daily_lead_limit: TOTAL_TARGET,
    email_allocation: EMAIL_TARGET,
    dm_allocation: DM_TARGET,
    configured_daily_email_limit: DAILY_EMAIL_LIMIT,
    configured_daily_dm_limit: DAILY_DM_LIMIT,
  })
  logger.info('finder', `Per-category cap: ${cappedLimit}`)
  logger.info('finder', `Daily cost limit: $${DAILY_OUTSCRAPER_LIMIT}`)

  // FIX 1: read active_cities from settings — source of truth for which cities to search
  const { data: activeCitySetting } = await supabase
    .from('settings')
    .select('value')
    .eq('key', 'active_cities')
    .single()

  const activeCities: string[] = activeCitySetting?.value
    .split(',')
    .map((c: string) => c.trim())
    .filter(Boolean) ?? ['Sydney']

  logger.info('finder', 'Active cities', { cities: activeCities })

  // Load active suburbs for active cities only — both filters must be satisfied
  const { data: suburbData } = await supabase
    .from('city_suburbs')
    .select('city, suburb')
    .eq('active', true)
    .in('city', activeCities)
    .order('last_used_at', { ascending: true, nullsFirst: true })
    .order('city')
    .order('suburb')

  // Use a Set per city so duplicate DB rows never produce duplicate suburbs
  const cityAreaSets: Record<string, Set<string>> = {}
  for (const row of suburbData ?? []) {
    if (!cityAreaSets[row.city]) cityAreaSets[row.city] = new Set()
    cityAreaSets[row.city].add(row.suburb)
  }
  const cityAreas: Record<string, string[]> = Object.fromEntries(
    Object.entries(cityAreaSets).map(([city, set]) => [city, [...set]])
  )
  // If a city is active but has no configured suburbs, search the city name itself
  for (const city of activeCities) {
    if (!cityAreas[city]?.length) cityAreas[city] = [city]
  }

  logger.info('finder', `Suburbs loaded: ${Object.values(cityAreas).flat().length} active suburbs`)

  // Load exhausted queries (cleanup expired first)
  await supabase.from('exhausted_queries').delete().lt('expires_at', new Date().toISOString())
  const { data: exhaustedData } = await supabase
    .from('exhausted_queries')
    .select('query')
    .gt('expires_at', new Date().toISOString())
  const exhaustedSet = new Set((exhaustedData ?? []).map((r) => r.query))
  logger.info('finder', `Exhausted queries cached: ${exhaustedSet.size}`)

  // Today's prior Outscraper spend
  const spentToday = await getDailyOutscraperSpend(supabase)
  logger.info('finder', `Prior spend today: $${spentToday.toFixed(4)}`)

  const seenQueries = new Set<string>()
  let costGuardHit = false

  let emailCount               = 0
  let dmCount                  = 0
  let callCount                = 0
  let totalResultsFetched      = 0
  let outscraperResultsFetched = 0

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // PHASE 1 — EMAIL LEADS
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  logger.info('finder', 'Phase 1: Email Leads')

  for (const category of EMAIL_CATEGORIES) {
    if (emailCount >= EMAIL_TARGET) break
    if (emailCount + dmCount >= TOTAL_TARGET) break
    if (costGuardHit) break

    const categoryLimit = category.capped ? cappedLimit : EMAIL_TARGET - emailCount
    let categoryEmailCount = 0
    logger.info('finder', `Category: ${category.name}`, { limit: categoryLimit })

    citySuburbLoop:
    for (const [city, suburbs] of Object.entries(cityAreas)) {
      const state = CITY_STATE[city] ?? 'Unknown'

      for (const suburb of suburbs) {
        if (emailCount >= EMAIL_TARGET) break citySuburbLoop
        if (emailCount + dmCount >= TOTAL_TARGET) break citySuburbLoop
        if (categoryEmailCount >= categoryLimit) break citySuburbLoop
        if (costGuardHit) break citySuburbLoop

        const queryTemplates = [
          "{base}",
          "best {base}",
          "{base} near me",
          "{base} in {city}",
          "{base} services {city}",
        ]

        const baseQuery = category.query.replace('{city}', suburb)

        const template =
          queryTemplates[Math.floor(Math.random() * queryTemplates.length)]

        const query = template
          .replace("{base}", baseQuery)
          .replace("{city}", suburb)
        // Check and guard BEFORE seenQueries.add — API call only happens after add
        if (seenQueries.has(query)) {
          logger.info('finder', `Skip duplicate query: ${query}`)
          continue
        }
        if (exhaustedSet.has(query)) {
          logger.info('finder', `Skip exhausted query: ${query}`)
          continue
        }
        seenQueries.add(query)

        let skip = 0
        let exhaustedThisQuery = false
        while (true) {
          if (emailCount >= EMAIL_TARGET) break
          if (emailCount + dmCount >= TOTAL_TARGET) break
          if (categoryEmailCount >= categoryLimit) break
          if (costGuardHit) break

          // Cost guard — check before every Outscraper call
          const currentRunEstimate = outscraperResultsFetched * 0.003
          if (spentToday + currentRunEstimate >= DAILY_OUTSCRAPER_LIMIT) {
            logger.warn('finder', 'Cost guard triggered', { limit: DAILY_OUTSCRAPER_LIMIT, spentToday, estimate: currentRunEstimate })
            await supabase.from('activity_log').insert({
              event_type:  'cost_guard_triggered',
              description: `Daily Outscraper limit $${DAILY_OUTSCRAPER_LIMIT} reached`,
              metadata:    { spent_today: spentToday, current_run_estimate: currentRunEstimate, limit: DAILY_OUTSCRAPER_LIMIT },
            })
            costGuardHit = true
            break
          }

          let results: OutscraperResult[]
          let apiUsed: string
          try {
            callCount++
            const searchResult = await searchBusinesses(query, category.batchSize, supabase, skip)
            await supabase
              .from('city_suburbs')
              .update({ last_used_at: new Date().toISOString() })
              .eq('active', true)
              .eq('city', city)
              .eq('suburb', suburb)
            results = searchResult.results
            apiUsed = searchResult.apiUsed
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error)
            if (msg.includes('402')) throw error  // balance exhausted — abort pipeline
            logger.error('finder', `Search error: ${query}`, { error: msg })
            await supabase.from('dead_letter_queue').insert({
              operation: 'outscraper_search',
              payload: { query, skip },
              error: msg,
            })
            await supabase.from('activity_log').insert({
              event_type: 'agent_error',
              description: `Search error for query "${query}": ${msg}`,
              metadata: { query, skip, error: msg },
            })
            break
          }
          totalResultsFetched += results.length
          if (apiUsed === 'outscraper' || apiUsed === 'outscraper_fallback') {
            outscraperResultsFetched += results.length
          }

          let newLeadsThisBatch = 0

          for (const result of results) {
            if (emailCount >= EMAIL_TARGET) break
            if (emailCount + dmCount >= TOTAL_TARGET) break
            if (categoryEmailCount >= categoryLimit) break

            const name       = result.name
            const rawWebsite = result.website || null

            if (isIrrelevant(name)) {
              logger.info('finder', `Skip irrelevant: ${name}`)
              continue
            }

            if (await isAlreadyInDB(supabase, name, city, result.phone)) {
              logger.info('finder', `Skip duplicate: ${name}`)
              continue
            }

            // Business whose website IS an Instagram page has no real web presence for email
            if (rawWebsite && INSTAGRAM_REGEX.test(rawWebsite)) {
              logger.info('finder', `Skip Instagram website: ${name}`)
              continue
            }

            let foundEmail: string | null = null
            let emailSource = ''
            if (result.email && isValidEmail(result.email)) {
              foundEmail  = result.email
              emailSource = 'outscraper'
            }

            if (!foundEmail && !rawWebsite) {
              logger.info('finder', `Skip ${name} — no website, cannot extract email`)
              continue
            }

            if (!foundEmail && rawWebsite) {
              const found = await findEmailForBusiness(rawWebsite)
              if (found) {
                foundEmail  = found.email
                emailSource = found.source
              }
            }

            if (foundEmail) {
              if (!isValidBusinessEmail(foundEmail, name)) {
                logger.info('finder', `Skip junk email: ${name}`, { email: foundEmail })
                continue
              }

              const { error } = await supabase.from('leads').insert({
                business_name:        name,
                category_name:        category.name,
                city:                 city,
                state:                state,
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
                logger.error('finder', `Insert failed: ${name}`, { error: error.message })
                continue
              }

              emailCount++
              categoryEmailCount++
              newLeadsThisBatch++
              logger.info('finder', `Email lead: ${name}`, { email: foundEmail, source: emailSource })

              await supabase.from('activity_log').insert({
                event_type:  'lead_found',
                description: `Email lead: ${name} — ${foundEmail}`,
                metadata:    { category: category.name, city, email: foundEmail, source: emailSource, type: 'email' },
              })
            } else {
              logger.info('finder', `No email: ${name}`)
            }
          }

          if (categoryEmailCount >= categoryLimit) break

          // Google Maps and cache results are complete in one call — no pagination
          if (apiUsed === 'google_maps' || apiUsed === 'cache') {
            exhaustedThisQuery = true
            break
          }

          if (results.length <= 1) {
            exhaustedThisQuery = true
            break
          }

          if (newLeadsThisBatch <= 1) {
            logger.info('finder', `Low yield: ${query}`, { newLeads: newLeadsThisBatch })
            break
          }

          skip += category.batchSize
        }

        if (exhaustedThisQuery) {
          await supabase.from('exhausted_queries').upsert({
            query,
            city,
            category: category.name,
            exhausted_at: new Date().toISOString(),
            expires_at:   new Date(Date.now() + 3 * 86_400_000).toISOString(),
          })
          exhaustedSet.add(query)
        }

        if (costGuardHit) break citySuburbLoop
      }
      if (costGuardHit) break
    }
    if (costGuardHit) break
  }

  logger.info('finder', 'Phase 1 complete', { emailCount, target: EMAIL_TARGET })

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // PHASE 2 — MANUAL INSTAGRAM DM QUEUE
  // No Outscraper calls — queue existing leads for manual Instagram outreach
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  logger.info('finder', 'Phase 2: Instagram DM Queue (free)')

  await cleanupDmQueue(supabase)

  // Get lead IDs already in dm_queue so we don't double-queue
  const { data: existingDms } = await supabase
    .from('dm_queue')
    .select('lead_id')
  const alreadyQueued = new Set((existingDms ?? []).map((r) => r.lead_id))

  // Find leads in DM categories with no email — not yet queued, in active cities
  const { data: dmCandidates } = await supabase
    .from('leads')
    .select('id, business_name, category_name, city, state')
    .in('category_name', DM_CATEGORY_NAMES)
    .is('email', null)
    .eq('status', 'new')
    .in('city', activeCities)
    .order('created_at', { ascending: false })
    .limit(DM_TARGET * 3)

  for (const lead of dmCandidates ?? []) {
    if (dmCount >= DM_TARGET) break
    if (emailCount + dmCount >= TOTAL_TARGET) break
    if (alreadyQueued.has(lead.id)) continue

    // Derive a suggested Instagram handle from the business name
    const suggestedHandle = lead.business_name
      .toLowerCase()
      .replace(/\s+/g, '')
      .replace(/[^a-z0-9_.]/g, '')
      .slice(0, 30) || 'instagram'

    const dmMessage =
      `Hi! We're Aussie Venture, a food & lifestyle media brand based in Sydney. ` +
      `We'd love to feature ${lead.business_name} in our content. ` +
      `Would you be open to a collaboration? DM us back if you're keen!`

    const { error } = await supabase.from('dm_queue').insert({
      lead_id:      lead.id,
      platform:     'instagram',
      handle:       suggestedHandle,
      message_text: dmMessage,
      status:       'pending',
    })

    if (error) {
      logger.error('finder', `DM queue insert failed: ${lead.business_name}`, { error: error.message })
      continue
    }

    dmCount++
    logger.info('finder', `DM queued: ${lead.business_name}`, { handle: suggestedHandle })

    await supabase.from('activity_log').insert({
      event_type:  'lead_found',
      description: `DM queued: ${lead.business_name} — search @${suggestedHandle} on Instagram`,
      metadata:    { category: lead.category_name, city: lead.city, suggested_handle: suggestedHandle, type: 'dm' },
    })
  }

  logger.info('finder', 'Phase 2 complete', { dmCount, target: DM_TARGET })

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // SUMMARY
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  const leadsKept     = emailCount + dmCount
  const estimatedCost = (outscraperResultsFetched * 0.003).toFixed(4)
  const efficiency    = `${leadsKept}/${totalResultsFetched} results used`
  const efficiencyPct = totalResultsFetched > 0 ? ((leadsKept / totalResultsFetched) * 100).toFixed(1) : '0.0'

  logger.info('finder', `Outscraper results fetched: ${outscraperResultsFetched}`)
  logger.info('finder', `Total results fetched (all APIs): ${totalResultsFetched}`)
  logger.info('finder', `Leads kept: ${leadsKept}`)
  logger.info('finder', `Efficiency: ${leadsKept}/${totalResultsFetched} (${efficiencyPct}%)`)
  logger.info('finder', `Estimated Outscraper cost: $${estimatedCost}`)

  logger.info('finder', 'Run complete', {
    emailLeads: emailCount,
    dmLeads: dmCount,
    outscraperCalls: callCount,
    resultsFetched: totalResultsFetched,
    estimatedCost,
    efficiency,
    costGuardHit,
  })
  if (costGuardHit) logger.warn('finder', `Run stopped by cost guard ($${DAILY_OUTSCRAPER_LIMIT} daily limit)`)

  await supabase.from('activity_log').insert({
    event_type:  'finder_complete',
    description: `Finder complete: ${emailCount} email leads, ${dmCount} DM leads queued (${callCount} Outscraper calls)`,
    metadata: {
      email_leads:        emailCount,
      dm_leads:           dmCount,
      email_target:       EMAIL_TARGET,
      dm_target:          DM_TARGET,
      total_target:       TOTAL_TARGET,
      outscraper_calls:   callCount,
      results_fetched:    totalResultsFetched,
      leads_kept:         leadsKept,
      outscraper_results: outscraperResultsFetched,
      estimated_cost:     estimatedCost,
      efficiency,
      cost_guard_hit:     costGuardHit,
    },
  })

  return leadsKept

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.error('finder', 'Fatal error', { error: message, stack: error instanceof Error ? error.stack : null })
    const isBalanceError = message.includes('402')
    await supabase.from('activity_log').insert({
      event_type: 'agent_error',
      description: `Agent failed: ${message}`,
      metadata: {
        agent: 'finder',
        error: message,
        stack: error instanceof Error ? error.stack : null,
        is_balance_error: isBalanceError,
        timestamp: new Date().toISOString(),
      },
    })
    throw error
  }
}

function extractInstagramHandle(text: string): string | null {
  const match = text.match(INSTAGRAM_REGEX)
  if (!match) return null
  const handle = match[1].toLowerCase()
  if (INSTAGRAM_SKIP.has(handle)) return null
  return `@${match[1]}`
}
