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

// Pool size per category — enricher cherry-picks the best from this pool
const POOL_PER_CATEGORY = 100

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

  const { data: citiesSetting } = await supabase
    .from('settings')
    .select('value')
    .eq('key', 'active_cities')
    .single()

  const activeCities = (citiesSetting?.value ?? 'Sydney')
    .split(',')
    .map((c: string) => c.trim())

  const { data: categories } = await supabase
    .from('categories')
    .select('*')
    .eq('status', 'active')

  if (!categories?.length) {
    console.log('No active categories found')
    return 0
  }

  console.log(`[finder] Building pool: up to ${POOL_PER_CATEGORY} candidates per category across ${categories.length} categories`)

  let totalPool = 0

  for (const category of categories) {
    const targetCities =
      category.cities === 'sydney_only'
        ? ['Sydney']
        : category.cities === 'custom'
        ? (category.custom_cities ?? [])
        : activeCities

    const keywords: string[] = category.search_keywords ?? []
    let poolForCategory = 0

    outer:
    for (const city of targetCities) {
      const suburbs = CITY_SUBURBS[city] ?? ['CBD']

      for (const suburb of suburbs) {
        for (const keyword of keywords) {
          if (poolForCategory >= POOL_PER_CATEGORY) break outer

          const query = buildSearchQuery(keyword, suburb, city)

          try {
            const results = await searchBusinesses(query, 20)

            for (const result of results) {
              if (poolForCategory >= POOL_PER_CATEGORY) break

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

              const { error: insertErr } = await supabase.from('leads').insert({
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

              if (insertErr) {
                console.error(`[finder] Insert failed for "${name}": ${insertErr.message}`)
                continue
              }

              poolForCategory++
              totalPool++
            }
          } catch (error) {
            console.error(`[finder] Search error for "${query}":`, error)
            await supabase.from('activity_log').insert({
              event_type: 'finder_error',
              description: `Error searching: ${query}`,
              metadata: { error: String(error) },
            })
          }
        }
      }
    }

    console.log(`[finder] ${category.name}: ${poolForCategory} candidates in pool`)
  }

  console.log(`[finder] Pool built — ${totalPool} total candidates across all categories`)

  await supabase.from('activity_log').insert({
    event_type: 'finder_complete',
    description: `Finder built pool of ${totalPool} candidates`,
    metadata: { total_pool: totalPool, categories: categories.length },
  })

  return totalPool
}
