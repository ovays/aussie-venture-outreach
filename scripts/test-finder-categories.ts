import { config } from 'dotenv'
config({ path: '.env.local' })

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { loadFinderCategoryDebugSnapshot } from '../agents/finder'

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required env var: ${name}`)
  return value
}

async function readSetting(
  supabase: SupabaseClient,
  key: string,
  fallback: string
): Promise<string> {
  const { data, error } = await supabase
    .from('settings')
    .select('value')
    .eq('key', key)
    .single()

  if (error) {
    console.warn(`Warning: could not read setting "${key}", using fallback "${fallback}": ${error.message}`)
  }

  return data?.value ?? fallback
}

async function run(): Promise<void> {
  const supabase = createClient(
    requireEnv('NEXT_PUBLIC_SUPABASE_URL'),
    requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    }
  )

  const categoryDebug = await loadFinderCategoryDebugSnapshot(supabase)

  console.log('LOCAL DRY RUN ONLY')
  console.log('No Google Maps/Outscraper calls. No emails. No queueing. No DB mutations.')

  console.log('\nACTIVE CATEGORIES')
  if (categoryDebug.finderCategories.length) {
    for (const category of categoryDebug.finderCategories) {
      console.log(`- ${category.name}`)
    }
  } else {
    console.log('(none)')
  }

  console.log('\nDISABLED CATEGORIES')
  if (categoryDebug.disabledCategories.length) {
    for (const category of categoryDebug.disabledCategories) {
      console.log(`- ${category.name} (${category.status ?? 'missing status'})`)
    }
  } else {
    console.log('(none)')
  }

  const dailyEmailLimit = parseInt(await readSetting(supabase, 'daily_email_limit', '30'), 10)
  const totalTarget = parseInt(await readSetting(supabase, 'daily_lead_limit', '40'), 10)
  const emailTarget = Math.min(dailyEmailLimit, totalTarget)
  const cappedLimit = emailTarget > 0 ? Math.max(1, Math.ceil(emailTarget / 4)) : 0

  console.log('\nFINDER CATEGORY SELECTION SIMULATION')
  console.log(`EMAIL_TARGET=${emailTarget}`)
  console.log(`cappedLimit=${cappedLimit}`)

  let simulatedEmailCount = 0
  for (const category of categoryDebug.finderCategories) {
    if (simulatedEmailCount >= emailTarget) break

    const categoryLimit = category.capped ? cappedLimit : emailTarget - simulatedEmailCount

    console.log(`- ${category.name}`)
    console.log(`  queries: ${category.queries.join(' | ')}`)
    console.log(`  dbStatus: active`)
    console.log(`  selectedByFinderDbLoader: true`)
    console.log(`  simulatedCategoryLimit: ${categoryLimit}`)

    // This dry run does not simulate lead yield; it only mirrors category selection order.
  }
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
