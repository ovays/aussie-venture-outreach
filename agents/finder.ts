import { createServiceClient } from '@/lib/supabase/server'
import { searchBusinesses } from '@/lib/outscraper'

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g
const MAILTO_REGEX = /href=["']mailto:([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/gi
const INSTAGRAM_REGEX = /instagram\.com\/([a-zA-Z0-9_.]{3,30})/i
const INSTAGRAM_SKIP = new Set(['p', 'reel', 'reels', 'stories', 'explore', 'accounts', 'share', 'sharer'])

// Phase 1 — first 4 categories are capped at EMAIL_TARGET/4 each to ensure variety
// Remaining categories fill whatever quota is left
// {city} is replaced at runtime with the active suburb being searched
const EMAIL_CATEGORIES = [
  { name: 'Travel Agents',          query: 'travel agent {city}',     capped: true  },
  { name: 'Tour Operators',         query: 'tour operator {city}',    capped: true  },
  { name: 'Boutique Hotels',        query: 'boutique hotel {city}',   capped: true  },
  { name: 'Beauty / Lash Studios',  query: 'beauty studio {city}',    capped: true  },
  { name: 'Hair Salons',            query: 'hair salon {city}',       capped: false },
  { name: 'Spas / Massage Studios', query: 'day spa {city}',          capped: false },
  { name: 'Halal Restaurants',      query: 'halal restaurant {city}', capped: false },
]

const DM_CATEGORIES = [
  { name: 'Halal Restaurants', query: 'halal restaurant {city}' },
  { name: 'Halal Cafes',       query: 'halal cafe {city}' },
  { name: 'Halal Bakeries',    query: 'halal bakery {city}' },
  { name: 'Nail Salons',       query: 'nail salon {city}' },
]

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
  'migration', 'migrant', 'visa', 'immigration', 'education', 'university',
  'college', 'school', 'tafe', 'accounting', 'tax', 'legal', 'lawyer',
  'solicitor', 'dentist', 'doctor', 'medical', 'pharmacy', 'clinic',
  'real estate', 'mortgage', 'insurance', 'finance', 'funeral',
]

function isIrrelevant(name: string): boolean {
  const lower = name.toLowerCase()
  return IRRELEVANT_KEYWORDS.some((kw) => lower.includes(kw))
}

// ── Instagram handle validation ──────────────────────────────────────────────

const INVALID_HANDLE_VALUES = new Set([
  'not found', 'not mentioned', 'n/a', 'none', 'null', '', 'unknown',
])

function isValidInstagramHandle(handle: string): boolean {
  const cleaned = handle.replace(/^@/, '').toLowerCase()
  if (!cleaned) return false
  if (INVALID_HANDLE_VALUES.has(cleaned)) return false
  if (!/^[a-zA-Z0-9_.]{3,30}$/.test(cleaned)) return false
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

async function isInstagramHandleInDB(
  supabase: ReturnType<typeof createServiceClient>,
  handle: string
): Promise<boolean> {
  const normalised = handle.startsWith('@') ? handle : `@${handle}`
  const { data } = await supabase
    .from('leads')
    .select('id')
    .eq('instagram_handle', normalised)
    .limit(1)
  return !!data?.length
}

// ── Daily spend helper ───────────────────────────────────────────────────────

async function getDailyOutscraperSpend(supabase: ReturnType<typeof createServiceClient>): Promise<number> {
  const todayStr = new Date().toISOString().slice(0, 10)
  const { data } = await supabase
    .from('activity_log')
    .select('metadata')
    .eq('event_type', 'finder_complete')
    .gte('created_at', `${todayStr}T00:00:00.000Z`)

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
  console.log('[finder] Cleaning up invalid DM queue entries...')

  const { error: fbErr } = await supabase.from('dm_queue').delete().eq('platform', 'facebook')
  if (fbErr) console.error('[finder] Cleanup Facebook delete error:', fbErr.message)

  await supabase.from('dm_queue').delete().is('handle', null)

  const invalidValues = ['Not found', 'Not mentioned', '', 'N/A', 'None', 'null', 'Unknown']
  for (const val of invalidValues) {
    await supabase.from('dm_queue').delete().eq('handle', val)
  }

  const { data: allDms } = await supabase
    .from('dm_queue')
    .select('id, lead_id, handle, created_at')
    .order('created_at', { ascending: true })

  if (allDms?.length) {
    const seenLeadIds = new Map<string, string>()
    const seenHandles = new Map<string, string>()
    const toDelete: string[] = []

    for (const dm of allDms) {
      let isDup = false
      if (seenLeadIds.has(dm.lead_id)) {
        isDup = true
      } else {
        seenLeadIds.set(dm.lead_id, dm.id)
      }
      const normHandle = dm.handle?.toLowerCase?.() ?? ''
      if (normHandle && seenHandles.has(normHandle)) {
        isDup = true
      } else if (normHandle) {
        seenHandles.set(normHandle, dm.id)
      }
      if (isDup) toDelete.push(dm.id)
    }

    if (toDelete.length) {
      console.log(`[finder] Removing ${toDelete.length} duplicate/invalid DM queue entries`)
      await supabase.from('dm_queue').delete().in('id', toDelete)
    } else {
      console.log('[finder] DM queue is clean — no duplicates found')
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
    console.log('System is paused - Finder agent skipped')
    return 0
  }

  const [emailLimitRow, dmLimitRow, totalLimitRow, dailyOutscraperLimitRow] = await Promise.all([
    supabase.from('settings').select('value').eq('key', 'daily_email_limit').single(),
    supabase.from('settings').select('value').eq('key', 'daily_dm_limit').single(),
    supabase.from('settings').select('value').eq('key', 'daily_lead_limit').single(),
    supabase.from('settings').select('value').eq('key', 'daily_outscraper_limit').single(),
  ])

  const EMAIL_TARGET            = parseInt(emailLimitRow.data?.value ?? '30', 10)
  const DM_TARGET               = parseInt(dmLimitRow.data?.value   ?? '10', 10)
  const TOTAL_TARGET            = parseInt(totalLimitRow.data?.value ?? '40', 10)
  const DAILY_OUTSCRAPER_LIMIT  = parseFloat(dailyOutscraperLimitRow.data?.value ?? '1.00')
  const cappedLimit             = Math.floor(EMAIL_TARGET / 4)

  console.log(`[finder] Targets: ${EMAIL_TARGET} email, ${DM_TARGET} DM, ${TOTAL_TARGET} total`)
  console.log(`[finder] Per-category cap (first 4): ${cappedLimit}`)
  console.log(`[finder] Daily cost limit: $${DAILY_OUTSCRAPER_LIMIT}`)

  // Load active suburbs from DB, grouped by city
  const { data: suburbData } = await supabase
    .from('city_suburbs')
    .select('city, suburb')
    .eq('active', true)
    .order('city')
    .order('suburb')

  const cityAreas: Record<string, string[]> = {}
  for (const row of suburbData ?? []) {
    if (!cityAreas[row.city]) cityAreas[row.city] = []
    cityAreas[row.city].push(row.suburb)
  }
  if (Object.keys(cityAreas).length === 0) cityAreas['Sydney'] = ['Sydney CBD']

  const activeCities = Object.keys(cityAreas)
  console.log(`[finder] Cities: ${activeCities.join(', ')} (${Object.values(cityAreas).flat().length} active suburbs)`)

  // FIX 2: clean up expired exhausted queries, then load non-expired ones
  await supabase.from('exhausted_queries').delete().lt('expires_at', new Date().toISOString())
  const { data: exhaustedData } = await supabase
    .from('exhausted_queries')
    .select('query')
    .gt('expires_at', new Date().toISOString())
  const exhaustedSet = new Set((exhaustedData ?? []).map((r) => r.query))
  console.log(`[finder] Exhausted queries cached: ${exhaustedSet.size} (skipped for 3 days)`)

  // FIX 3: today's prior spend
  const spentToday = await getDailyOutscraperSpend(supabase)
  console.log(`[finder] Prior spend today: $${spentToday.toFixed(4)}`)

  // FIX 4: seen queries this run (dedup within run)
  const seenQueries = new Set<string>()
  let costGuardHit = false

  let emailCount          = 0
  let dmCount             = 0
  let callCount           = 0
  let totalResultsFetched = 0
  const phase1Names = new Set<string>()

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // PHASE 1 — EMAIL LEADS
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  console.log('\n[finder] ═══ PHASE 1: Email Leads ═══')

  for (const category of EMAIL_CATEGORIES) {
    if (emailCount >= EMAIL_TARGET) break
    if (emailCount + dmCount >= TOTAL_TARGET) break
    if (costGuardHit) break

    const categoryLimit = category.capped ? cappedLimit : EMAIL_TARGET - emailCount
    let categoryEmailCount = 0
    console.log(`\n[finder] Category: ${category.name} (limit: ${categoryLimit})`)

    citySuburbLoop:
    for (const [city, suburbs] of Object.entries(cityAreas)) {
      const state = CITY_STATE[city] ?? 'Unknown'

      for (const suburb of suburbs) {
        if (emailCount >= EMAIL_TARGET) break citySuburbLoop
        if (emailCount + dmCount >= TOTAL_TARGET) break citySuburbLoop
        if (categoryEmailCount >= categoryLimit) break citySuburbLoop
        if (costGuardHit) break citySuburbLoop

        const query = category.query.replace('{city}', suburb)

        // FIX 4: skip if already seen or exhausted
        if (seenQueries.has(query)) {
          console.log(`[finder] Skip duplicate query: "${query}"`)
          continue
        }
        if (exhaustedSet.has(query)) {
          console.log(`[finder] Skip exhausted query: "${query}"`)
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

          // FIX 3: cost guard — check before every Outscraper call
          const currentRunEstimate = callCount * 10 * 0.003
          if (spentToday + currentRunEstimate >= DAILY_OUTSCRAPER_LIMIT) {
            console.log(`[finder] COST GUARD: Daily limit $${DAILY_OUTSCRAPER_LIMIT} reached — stopping`)
            await supabase.from('activity_log').insert({
              event_type:  'cost_guard_triggered',
              description: `Daily Outscraper limit $${DAILY_OUTSCRAPER_LIMIT} reached`,
              metadata:    { spent_today: spentToday, current_run_estimate: currentRunEstimate, limit: DAILY_OUTSCRAPER_LIMIT },
            })
            costGuardHit = true
            break
          }

          let results
          try {
            callCount++
            results = await searchBusinesses(query, 10, skip)
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error)
            if (msg.includes('402')) throw error  // balance exhausted — abort pipeline
            console.error(`[finder] Search error for "${query}":`, error)
            break
          }
          totalResultsFetched += results.length

          let newLeadsThisBatch = 0

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

            if (await isAlreadyInDB(supabase, name, city, result.phone)) {
              console.log(`❌ Skip: ${name} — already in DB`)
              continue
            }

            if (rawWebsite && INSTAGRAM_REGEX.test(rawWebsite)) {
              const handle = extractInstagramHandle(rawWebsite)
              if (handle) console.log(`📌 Noted for Phase 2: ${name} → ${handle}`)
              continue
            }

            let foundEmail: string | null = null
            let emailSource = ''
            if (result.email && isValidEmail(result.email)) {
              foundEmail  = result.email
              emailSource = 'outscraper'
            }

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
                console.error(`[finder] Insert failed for "${name}": ${error.message}`)
                continue
              }

              emailCount++
              categoryEmailCount++
              newLeadsThisBatch++
              phase1Names.add(name)
              console.log(`✅ Email: ${name} → ${foundEmail} (source: ${emailSource})`)

              await supabase.from('activity_log').insert({
                event_type:  'lead_found',
                description: `Email lead: ${name} — ${foundEmail}`,
                metadata:    { category: category.name, city, email: foundEmail, source: emailSource, type: 'email' },
              })
            } else {
              console.log(`❌ Skip: ${name} — no email found`)
            }
          }

          if (categoryEmailCount >= categoryLimit) break  // quota filled

          // FIX 2: mark exhausted when results page is less than full
          if (results.length < 10) {
            exhaustedThisQuery = true
            break
          }

          // FIX 1: low yield — 10 results but <=1 usable lead, not worth continuing
          if (newLeadsThisBatch <= 1) {
            console.log(`[finder] Low yield query exhausted: "${query}" — only ${newLeadsThisBatch} leads from 10 results`)
            exhaustedThisQuery = true
            break
          }

          skip += 10
        }

        // FIX 2: persist exhausted query to DB so it's skipped for 3 days
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

  console.log(`\n[finder] Phase 1 complete: ${emailCount}/${EMAIL_TARGET} email leads`)

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // PHASE 2 — INSTAGRAM LEADS ONLY
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  console.log('\n[finder] ═══ PHASE 2: Instagram Leads ═══')

  await cleanupDmQueue(supabase)

  for (const category of DM_CATEGORIES) {
    if (dmCount >= DM_TARGET) break
    if (emailCount + dmCount >= TOTAL_TARGET) break
    if (costGuardHit) break

    console.log(`\n[finder] Category: ${category.name}`)

    dmCitySuburbLoop:
    for (const [city, suburbs] of Object.entries(cityAreas)) {
      const state = CITY_STATE[city] ?? 'Unknown'

      for (const suburb of suburbs) {
        if (dmCount >= DM_TARGET) break dmCitySuburbLoop
        if (emailCount + dmCount >= TOTAL_TARGET) break dmCitySuburbLoop
        if (costGuardHit) break dmCitySuburbLoop

        const query = category.query.replace('{city}', suburb)

        // FIX 4: skip if already seen or exhausted
        if (seenQueries.has(query)) {
          console.log(`[finder] Skip duplicate query: "${query}"`)
          continue
        }
        if (exhaustedSet.has(query)) {
          console.log(`[finder] Skip exhausted query: "${query}"`)
          continue
        }
        seenQueries.add(query)

        let skip = 0
        let exhaustedThisQuery = false
        while (true) {
          if (dmCount >= DM_TARGET) break
          if (emailCount + dmCount >= TOTAL_TARGET) break
          if (costGuardHit) break

          // FIX 3: cost guard — check before every Outscraper call
          const currentRunEstimate = callCount * 10 * 0.003
          if (spentToday + currentRunEstimate >= DAILY_OUTSCRAPER_LIMIT) {
            console.log(`[finder] COST GUARD: Daily limit $${DAILY_OUTSCRAPER_LIMIT} reached — stopping`)
            await supabase.from('activity_log').insert({
              event_type:  'cost_guard_triggered',
              description: `Daily Outscraper limit $${DAILY_OUTSCRAPER_LIMIT} reached`,
              metadata:    { spent_today: spentToday, current_run_estimate: currentRunEstimate, limit: DAILY_OUTSCRAPER_LIMIT },
            })
            costGuardHit = true
            break
          }

          let results
          try {
            callCount++
            results = await searchBusinesses(query, 10, skip)
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error)
            if (msg.includes('402')) throw error  // balance exhausted — abort pipeline
            console.error(`[finder] Search error for "${query}":`, error)
            break
          }
          totalResultsFetched += results.length

          let newLeadsThisBatch = 0

          for (const result of results) {
            if (dmCount >= DM_TARGET) break
            if (emailCount + dmCount >= TOTAL_TARGET) break

            const name       = result.name
            const rawWebsite = result.website || null

            if (phase1Names.has(name)) continue

            if (await isAlreadyInDB(supabase, name, city, result.phone)) {
              console.log(`❌ Skip: ${name} — already in DB`)
              continue
            }

            let instagramHandle: string | null = null

            const resultAny = result as unknown as Record<string, unknown>
            for (const key of ['instagram', 'instagram_handle']) {
              const val = resultAny[key]
              if (typeof val === 'string' && val.trim()) {
                const extracted = extractInstagramHandle(val)
                if (extracted && isValidInstagramHandle(extracted)) {
                  instagramHandle = extracted
                  break
                }
                const bare = val.trim()
                const candidate = bare.startsWith('@') ? bare : `@${bare}`
                if (isValidInstagramHandle(candidate)) {
                  instagramHandle = candidate
                  break
                }
              }
            }

            if (!instagramHandle) {
              const socialVal = resultAny['social_media']
              if (typeof socialVal === 'string' && INSTAGRAM_REGEX.test(socialVal)) {
                const extracted = extractInstagramHandle(socialVal)
                if (extracted && isValidInstagramHandle(extracted)) instagramHandle = extracted
              }
            }

            if (!instagramHandle && rawWebsite && INSTAGRAM_REGEX.test(rawWebsite)) {
              const extracted = extractInstagramHandle(rawWebsite)
              if (extracted && isValidInstagramHandle(extracted)) instagramHandle = extracted
            }

            if (!instagramHandle) {
              console.log(`❌ Skip: ${name} — no valid Instagram handle found`)
              continue
            }

            if (await isInstagramHandleInDB(supabase, instagramHandle)) {
              console.log(`❌ Skip: ${name} — Instagram handle ${instagramHandle} already in DB`)
              continue
            }

            const { error } = await supabase.from('leads').insert({
              business_name:        name,
              category_name:        category.name,
              city:                 city,
              state:                state,
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
            newLeadsThisBatch++
            console.log(`📱 DM: ${name} → ${instagramHandle}`)

            await supabase.from('activity_log').insert({
              event_type:  'lead_found',
              description: `DM lead: ${name} — ${instagramHandle}`,
              metadata:    { category: category.name, city, instagram: instagramHandle, type: 'dm' },
            })
          }

          if (dmCount >= DM_TARGET) break

          // FIX 2: mark exhausted when results page is less than full
          if (results.length < 10) {
            exhaustedThisQuery = true
            break
          }

          // FIX 1: low yield — 10 results but <=1 usable DM lead
          if (newLeadsThisBatch <= 1) {
            console.log(`[finder] Low yield query exhausted: "${query}" — only ${newLeadsThisBatch} leads from 10 results`)
            exhaustedThisQuery = true
            break
          }

          skip += 10
        }

        // FIX 2: persist exhausted query to DB
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

        if (costGuardHit) break dmCitySuburbLoop
      }
      if (costGuardHit) break
    }
    if (costGuardHit) break
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // SUMMARY
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  const leadsKept     = emailCount + dmCount
  const estimatedCost = (totalResultsFetched * 0.003).toFixed(4)
  const efficiency    = `${leadsKept}/${totalResultsFetched} results used`

  console.log(`\nPhase 1: ${emailCount}/${EMAIL_TARGET} email leads`)
  console.log(`Phase 2: ${dmCount}/${DM_TARGET} DM leads`)
  console.log(`Outscraper calls: ${callCount} | Results fetched: ${totalResultsFetched}`)
  console.log(`Estimated cost: $${estimatedCost} | Efficiency: ${efficiency}`)
  if (costGuardHit) console.log(`⚠️  Run stopped early by cost guard ($${DAILY_OUTSCRAPER_LIMIT} daily limit)`)

  await supabase.from('activity_log').insert({
    event_type:  'finder_complete',
    description: `Finder complete: ${emailCount} email leads, ${dmCount} DM leads (${callCount} searches, ${totalResultsFetched} results fetched)`,
    metadata: {
      email_leads:        emailCount,
      dm_leads:           dmCount,
      email_target:       EMAIL_TARGET,
      dm_target:          DM_TARGET,
      total_target:       TOTAL_TARGET,
      outscraper_calls:   callCount,
      results_fetched:    totalResultsFetched,
      leads_kept:         leadsKept,
      estimated_cost:     estimatedCost,
      efficiency,
      cost_guard_hit:     costGuardHit,
    },
  })

  return leadsKept

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[finder] Fatal error:', error)
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
