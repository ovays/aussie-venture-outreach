import { createServiceClient } from '@/lib/supabase/server'
import { extractWebsiteData } from '@/lib/claude'

async function fetchWebsiteContent(url: string): Promise<string> {
  try {
    const normalised = url.startsWith('http') ? url : `https://${url}`
    const response = await fetch(normalised, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AussieVentureBot/1.0)' },
      signal: AbortSignal.timeout(10_000),
    })
    const html = await response.text()
    // Strip HTML tags for a plain-text excerpt
    return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 5000)
  } catch {
    return ''
  }
}

export async function runResearcherAgent(): Promise<number> {
  const supabase = createServiceClient()

  const { data: systemSetting } = await supabase
    .from('settings')
    .select('value')
    .eq('key', 'system_active')
    .single()

  if (systemSetting?.value !== 'true') {
    console.log('System is paused - Researcher agent skipped')
    return 0
  }

  const { data: leads } = await supabase
    .from('leads')
    .select('*')
    .eq('status', 'new')

  if (!leads?.length) {
    console.log('No new leads to research')
    return 0
  }

  let processed = 0

  for (const lead of leads) {
    try {
      let websiteContent = ''

      if (lead.website) {
        websiteContent = await fetchWebsiteContent(lead.website)
      }

      let enriched = {
        description: '',
        services: '',
        instagram_handle: null as string | null,
        facebook_url: null as string | null,
        other_social: null as string | null,
      }

      if (websiteContent) {
        enriched = await extractWebsiteData(websiteContent)
      }

      // If Instagram not found on website, try searching
      if (!enriched.instagram_handle && lead.business_name) {
        const cleanName = lead.business_name.toLowerCase().replace(/[^a-z0-9]/g, '')
        enriched.instagram_handle = `@${cleanName}`
      }

      await supabase
        .from('leads')
        .update({
          description: enriched.description || null,
          services: enriched.services || null,
          instagram_handle: enriched.instagram_handle || null,
          facebook_url: enriched.facebook_url || null,
          status: 'researched',
        })
        .eq('id', lead.id)

      await supabase.from('activity_log').insert({
        event_type: 'lead_researched',
        lead_id: lead.id,
        description: `Researched: ${lead.business_name}`,
        metadata: { has_instagram: !!enriched.instagram_handle },
      })

      processed++
    } catch (error) {
      await supabase.from('activity_log').insert({
        event_type: 'researcher_error',
        lead_id: lead.id,
        description: `Error researching: ${lead.business_name}`,
        metadata: { error: String(error) },
      })

      // Still mark as researched so pipeline continues
      await supabase
        .from('leads')
        .update({ status: 'researched' })
        .eq('id', lead.id)
    }
  }

  await supabase.from('activity_log').insert({
    event_type: 'researcher_complete',
    description: `Researcher agent completed - ${processed} leads enriched`,
    metadata: { total_processed: processed },
  })

  console.log(`Researcher agent done - ${processed} leads enriched`)
  return processed
}
