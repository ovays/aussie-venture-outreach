import { createServiceClient } from '@/lib/supabase/server'
import { searchBusinesses, buildSearchQuery } from '@/lib/outscraper'

const SYDNEY_SUBURBS = [
  'Lakemba', 'Bankstown', 'Auburn', 'Parramatta', 'Blacktown',
  'Liverpool', 'Fairfield', 'Cabramatta', 'Strathfield', 'Burwood',
  'Newtown', 'Surry Hills', 'Glebe', 'Leichhardt', 'Marrickville',
  'Bondi', 'Coogee', 'Manly', 'Chatswood', 'Hurstville',
]

const CITY_SUBURBS: Record<string, string[]> = {
  Sydney: SYDNEY_SUBURBS,
  Melbourne: ['CBD', 'Fitzroy', 'Collingwood', 'Richmond', 'St Kilda', 'Prahran', 'South Yarra', 'Brunswick', 'Northcote', 'Carlton'],
  Brisbane: ['CBD', 'Fortitude Valley', 'South Brisbane', 'West End', 'Newstead', 'New Farm', 'Paddington', 'Toowong'],
  Perth: ['CBD', 'Fremantle', 'Subiaco', 'Mount Lawley', 'Leederville', 'Northbridge', 'Victoria Park'],
  Adelaide: ['CBD', 'Norwood', 'Unley', 'Glenelg', 'Prospect', 'Burnside'],
}

const EMAIL_REGEX = /[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}/gi
const INSTAGRAM_REGEX = /instagram\.com\/([a-zA-Z0-9_.]{3,30})/i
const FACEBOOK_REGEX = /facebook\.com\/(pages\/[^/\s"']+\/\d+|[a-zA-Z0-9.]{5,50})/i
const INSTAGRAM_SKIP = new Set(['p', 'reel', 'reels', 'stories', 'explore', 'accounts', 'share', 'sharer'])
const FACEBOOK_SKIP = new Set(['share', 'sharer', 'dialog', 'login', 'pages', 'groups', 'events', 'watch', 'photo', 'photo.php'])

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
  } catch (err) {
    clearTimeout(timeoutId)
    console.log(`[finder] Fetch skipped (${url}): ${err instanceof Error ? err.message : String(err)}`)
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

function extractInstagram(text: string): string | null {
  const match = text.match(INSTAGRAM_REGEX)
  if (!match) return null
  const handle = match[1].toLowerCase()
  if (INSTAGRAM_SKIP.has(handle)) return null
  return `@${match[1]}`
}

function extractFacebook(text: string): string | null {
  const match = text.match(FACEBOOK_REGEX)
  if (!match) return null
  const path = match[1].split('/')[0].toLowerCase()
  if (FACEBOOK_SKIP.has(path)) return null
  return `https://facebook.com/${match[1]}`
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

  // Read quota targets
  const [emailLimitRow, dmLimitRow] = await Promise.all([
    supabase.from('settings').select('value').eq('key', 'daily_email_limit').single(),
    supabase.from('settings').select('value').eq('key', 'daily_dm_limit').single(),
  ])

  const EMAIL_TARGET = parseInt(emailLimitRow.data?.value ?? '30', 10)
  const DM_TARGET = parseInt(dmLimitRow.data?.value ?? '10', 10)

  const { data: citiesSetting } = await supabase
    .from('settings')
    .select('value')
    .eq('key', 'active_cities')
    .single()

  const activeCities = (citiesSetting?.value ?? 'Sydney').split(',').map((c: string) => c.trim())

  const { data: categories } = await supabase
    .from('categories')
    .select('*')
    .eq('status', 'active')

  if (!categories?.length) {
    console.log('No active categories found')
    return 0
  }

  console.log(`[finder] Targets: ${EMAIL_TARGET} email leads, ${DM_TARGET} DM leads`)

  let emailCount = 0
  let dmCount = 0
  let outscraperCalls = 0

  outer:
  for (const category of categories) {
    const targetCities =
      category.cities === 'sydney_only' ? ['Sydney']
      : category.cities === 'custom' ? (category.custom_cities ?? [])
      : activeCities

    const keywords: string[] = category.search_keywords ?? []

    for (const city of targetCities) {
      const suburbs = CITY_SUBURBS[city] ?? ['CBD']

      for (const suburb of suburbs) {
        for (const keyword of keywords) {
          if (emailCount >= EMAIL_TARGET && dmCount >= DM_TARGET) break outer

          const query = buildSearchQuery(keyword, suburb, city)
          console.log(`[finder] Search #${++outscraperCalls}: "${query}"`)

          let results
          try {
            results = await searchBusinesses(query, 20)
          } catch (error) {
            console.error(`[finder] Search error for "${query}":`, error)
            continue
          }

          for (const result of results) {
            if (emailCount >= EMAIL_TARGET && dmCount >= DM_TARGET) break

            const name = result.name

            // Dedup check against existing DB leads
            const { data: existing } = await supabase
              .from('leads')
              .select('id')
              .or(
                [
                  `and(business_name.eq.${name},suburb.eq.${suburb})`,
                  result.phone ? `phone.eq.${result.phone}` : null,
                  result.email ? `email.eq.${result.email}` : null,
                ]
                  .filter(Boolean)
                  .join(',')
              )
              .limit(1)

            if (existing?.length) {
              console.log(`[finder] Already in DB: "${name}"`)
              continue
            }

            // Step 1: Check Outscraper email field (free)
            let foundEmail: string | null = result.email || null
            let websiteText = ''
            let instagramHandle: string | null = null
            let facebookUrl: string | null = null

            // Step 2: Fetch website if no email yet (or always, to get social links)
            if (result.site) {
              websiteText = await fetchWebsiteText(result.site)
              if (websiteText) {
                if (!foundEmail) foundEmail = extractEmail(websiteText)
                instagramHandle = extractInstagram(websiteText)
                facebookUrl = extractFacebook(websiteText)
              }
            }

            if (foundEmail && emailCount < EMAIL_TARGET) {
              // ── Email lead ──────────────────────────────────────────────
              const { error } = await supabase.from('leads').insert({
                business_name: name,
                category_id: category.id,
                category_name: category.name,
                halal: category.halal_filter,
                address: result.full_address,
                suburb,
                city,
                state: 'NSW',
                phone: result.phone || null,
                email: foundEmail,
                website: result.site || null,
                instagram_handle: instagramHandle,
                facebook_url: facebookUrl,
                google_rating: result.rating || null,
                google_reviews_count: result.reviews || null,
                status: 'researched',
                outreach_channel: 'email',
              })

              if (error) {
                console.error(`[finder] Insert failed for "${name}": ${error.message}`)
                continue
              }

              emailCount++
              console.log(`✅ Email lead #${emailCount}: "${name}" — ${foundEmail}`)

              await supabase.from('activity_log').insert({
                event_type: 'lead_found',
                description: `Email lead: ${name}, ${suburb} — ${foundEmail}`,
                metadata: { category: category.name, city, suburb, email: foundEmail, type: 'email' },
              })
            } else if (!foundEmail && (instagramHandle || facebookUrl) && dmCount < DM_TARGET) {
              // ── DM lead ─────────────────────────────────────────────────
              const { error } = await supabase.from('leads').insert({
                business_name: name,
                category_id: category.id,
                category_name: category.name,
                halal: category.halal_filter,
                address: result.full_address,
                suburb,
                city,
                state: 'NSW',
                phone: result.phone || null,
                email: null,
                website: result.site || null,
                instagram_handle: instagramHandle,
                facebook_url: facebookUrl,
                google_rating: result.rating || null,
                google_reviews_count: result.reviews || null,
                status: 'researched',
                outreach_channel: 'instagram',
              })

              if (error) {
                console.error(`[finder] Insert failed for "${name}": ${error.message}`)
                continue
              }

              dmCount++
              console.log(`📱 DM lead #${dmCount}: "${name}" — ${instagramHandle ?? facebookUrl}`)

              await supabase.from('activity_log').insert({
                event_type: 'lead_found',
                description: `DM lead: ${name}, ${suburb} — ${instagramHandle ?? facebookUrl}`,
                metadata: { category: category.name, city, suburb, instagram: instagramHandle, type: 'dm' },
              })
            } else {
              console.log(`❌ Skipped: "${name}" (no email, no Instagram)`)
            }
          }
        }
      }
    }
  }

  const total = emailCount + dmCount
  console.log(`[finder] Done — ${emailCount}/${EMAIL_TARGET} email leads, ${dmCount}/${DM_TARGET} DM leads, ${outscraperCalls} Outscraper calls`)

  await supabase.from('activity_log').insert({
    event_type: 'finder_complete',
    description: `Finder complete: ${emailCount} email leads, ${dmCount} DM leads (${outscraperCalls} searches)`,
    metadata: { email_leads: emailCount, dm_leads: dmCount, email_target: EMAIL_TARGET, dm_target: DM_TARGET, outscraper_calls: outscraperCalls },
  })

  return total
}
