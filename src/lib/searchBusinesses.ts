import type { SupabaseClient } from '@supabase/supabase-js'
import { searchBusinesses as searchOutscraper, type OutscraperResult } from './outscraper'
import { searchBusinessesGoogle } from './googleplaces'
import { logger } from './logger'

export type { OutscraperResult }

export type ApiUsed = 'google_maps' | 'outscraper' | 'outscraper_fallback' | 'cache'

export interface SearchResult {
  results: OutscraperResult[]
  apiUsed: ApiUsed
}

async function getSetting(supabase: SupabaseClient, key: string): Promise<string | null> {
  const { data } = await supabase.from('settings').select('value').eq('key', key).single()
  return data?.value ?? null
}

async function updateSetting(supabase: SupabaseClient, key: string, value: string): Promise<void> {
  await supabase.from('settings').update({ value, updated_at: new Date().toISOString() }).eq('key', key)
}

export async function searchBusinesses(
  query: string,
  limit: number,
  supabase: SupabaseClient,
  skip = 0
): Promise<SearchResult> {
  // Cache only applies to first page (skip=0)
  if (skip === 0) {
    const { data: cached } = await supabase
      .from('search_cache')
      .select('results, api_used')
      .eq('query', query)
      .gt('expires_at', new Date().toISOString())
      .maybeSingle()

    if (cached) {
      logger.info('search', `Cache hit: "${query}"`)
      return {
        results: (cached.results as OutscraperResult[]).slice(0, limit),
        apiUsed: 'cache',
      }
    }
  }

  const primaryApi = await getSetting(supabase, 'primary_search_api') ?? 'outscraper'
  const googleLimit = parseFloat(await getSetting(supabase, 'google_maps_monthly_limit') ?? '180')
  const hasGoogleKey = !!process.env.GOOGLE_MAPS_API_KEY

  // Auto-reset monthly spend if month has rolled over
  const now = new Date()
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const lastResetMonth = await getSetting(supabase, 'google_maps_spend_reset_month') ?? ''
  let googleSpend = parseFloat(await getSetting(supabase, 'google_maps_spend_this_month') ?? '0')
  if (lastResetMonth !== currentMonth) {
    await updateSetting(supabase, 'google_maps_spend_this_month', '0.0000')
    await updateSetting(supabase, 'google_maps_spend_reset_month', currentMonth)
    googleSpend = 0
    logger.info('search', `Google Maps monthly spend reset for ${currentMonth}`)
  }

  const withinBudget = googleSpend < googleLimit
  const useGoogle = primaryApi === 'google_maps' && hasGoogleKey && withinBudget && skip === 0

  let results: OutscraperResult[]
  let apiUsed: ApiUsed

  if (useGoogle) {
    try {
      results = await searchBusinessesGoogle(query, limit)
      const costPerRequest = parseFloat(await getSetting(supabase, 'google_maps_cost_per_request') ?? '0.032')
      const newSpend = googleSpend + costPerRequest
      await updateSetting(supabase, 'google_maps_spend_this_month', newSpend.toFixed(4))
      logger.info('search', `Google Maps: "${query}" (spend: $${newSpend.toFixed(4)}/$${googleLimit})`)
      apiUsed = 'google_maps'
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      logger.warn('search', `Google Maps failed for "${query}" — falling back to Outscraper`, { error: msg })
      results = await searchOutscraper(query, limit, skip)
      apiUsed = 'outscraper_fallback'
    }
  } else {
    if (primaryApi === 'google_maps' && !withinBudget) {
      logger.warn('search', `Google Maps budget reached ($${googleSpend.toFixed(2)}/$${googleLimit}) — using Outscraper`)
    }
    results = await searchOutscraper(query, limit, skip)
    apiUsed = 'outscraper'
  }

  // Cache results for first page only
  if (skip === 0 && results.length > 0) {
    await supabase.from('search_cache').upsert(
      {
        query,
        results,
        api_used: apiUsed,
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      },
      { onConflict: 'query' }
    )
  }

  return { results, apiUsed }
}
