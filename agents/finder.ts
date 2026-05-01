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

export async function runFinderAgent(): Promise<number> {
  const supabase = createServiceClient()

  // Check master switch
  const { data: systemSetting } = await supabase
    .from('settings')
    .select('value')
    .eq('key', 'system_active')
    .single()

  if (systemSetting?.value !== 'true') {
    console.log('System is paused - Finder agent skipped')
    return 0
  }

  // Read daily limit
  const { data: limitSetting } = await supabase
    .from('settings')
    .select('value')
    .eq('key', 'daily_lead_limit')
    .single()

  const dailyLimit = parseInt(limitSetting?.value ?? '50', 10)

  // Read active cities
  const { data: citiesSetting } = await supabase
    .from('settings')
    .select('value')
    .eq('key', 'active_cities')
    .single()

  const activeCities = (citiesSetting?.value ?? 'Sydney')
    .split(',')
    .map((c: string) => c.trim())

  // Read active categories
  const { data: categories } = await supabase
    .from('categories')
    .select('*')
    .eq('status', 'active')

  if (!categories?.length) {
    console.log('No active categories found')
    return 0
  }

  let totalFound = 0

  for (const category of categories) {
    if (totalFound >= dailyLimit) break

    const targetCities =
      category.cities === 'sydney_only'
        ? ['Sydney']
        : category.cities === 'custom'
        ? (category.custom_cities ?? [])
        : activeCities

    const keywords: string[] = category.search_keywords ?? []

    for (const city of targetCities) {
      if (totalFound >= dailyLimit) break

      const suburbs = CITY_SUBURBS[city] ?? ['CBD']

      for (const suburb of suburbs) {
        if (totalFound >= dailyLimit) break

        for (const keyword of keywords) {
          if (totalFound >= dailyLimit) break

          const query = buildSearchQuery(keyword, suburb, city)

          try {
            const results = await searchBusinesses(query, 20)

            for (const result of results) {
              if (totalFound >= dailyLimit) break

              // Duplicate check
              const name = result.name
              const phone = result.phone
              const email = result.email

              const { data: existing } = await supabase
                .from('leads')
                .select('id')
                .or(
                  `and(business_name.eq.${name},suburb.eq.${suburb}),phone.eq.${phone},email.eq.${email}`
                )
                .limit(1)

              if (existing?.length) continue

              // Save new lead
              await supabase.from('leads').insert({
                business_name: name,
                category_id: category.id,
                category_name: category.name,
                halal: category.halal_filter,
                address: result.full_address,
                suburb,
                city,
                state: 'NSW',
                phone: result.phone || null,
                email: result.email || null,
                website: result.site || null,
                google_rating: result.rating || null,
                google_reviews_count: result.reviews || null,
                status: 'new',
              })

              await supabase.from('activity_log').insert({
                event_type: 'lead_found',
                description: `New lead found: ${name} in ${suburb}, ${city}`,
                metadata: { category: category.name, city, suburb },
              })

              totalFound++
            }
          } catch (error) {
            await supabase.from('activity_log').insert({
              event_type: 'finder_error',
              description: `Error searching: ${query}`,
              metadata: { error: String(error) },
            })
          }
        }
      }
    }
  }

  await supabase.from('activity_log').insert({
    event_type: 'finder_complete',
    description: `Finder agent completed - ${totalFound} new leads found`,
    metadata: { total_found: totalFound },
  })

  console.log(`Finder agent done - ${totalFound} leads found`)
  return totalFound
}
