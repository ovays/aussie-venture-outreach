import { createServiceClient } from '@/lib/supabase/server'
import { extractWebsiteData, agenticEmailSearch } from '@/lib/claude'

async function fetchRawHtml(url: string): Promise<string> {
  const normalised = url.startsWith('http') ? url : `https://${url}`
  const res = await fetch(normalised, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AussieVentureBot/1.0)' },
    signal: AbortSignal.timeout(10_000),
  })
  return res.text()
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

  console.log(`[researcher] Found ${leads?.length ?? 0} leads with status=new`)

  if (!leads?.length) {
    console.log('[researcher] Nothing to process')
    return 0
  }

  let processed = 0
  let emailsFound = 0
  const methodCounts: Record<string, number> = {}

  for (const lead of leads) {
    console.log(`[researcher] Lead: "${lead.business_name}" | existing email: ${lead.email ?? 'NONE'} | website: ${lead.website ?? 'NONE'}`)

    try {
      let websiteText = ''
      let rawHtml = ''
      let foundEmail: string | null = lead.email ?? null
      let emailMethod = 'outscraper'
      let emailRounds = 0

      if (lead.website) {
        try {
          rawHtml = await fetchRawHtml(lead.website)
          websiteText = rawHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 5000)
        } catch {
          console.log(`[researcher] Could not fetch website for "${lead.business_name}"`)
        }
      }

      // Agentic email search — only if no email from Outscraper and we have a website
      if (!foundEmail && lead.website && websiteText) {
        console.log(`[researcher] Starting agentic email search for "${lead.business_name}"`)

        const result = await agenticEmailSearch({
          business_name: lead.business_name,
          website_url: lead.website,
          category: lead.category_name ?? '',
          homepage_content: websiteText,
        })

        if (result.email) {
          foundEmail = result.email
          emailsFound++
          console.log(`[researcher] Found email via ${result.method} in ${result.rounds} round(s): ${result.email}`)
        } else {
          console.log(`[researcher] No email found for "${lead.business_name}" after ${result.rounds} round(s)`)
        }

        emailMethod = result.method
        emailRounds = result.rounds
        methodCounts[result.method] = (methodCounts[result.method] ?? 0) + 1
      } else if (foundEmail) {
        emailMethod = 'outscraper'
        methodCounts['outscraper'] = (methodCounts['outscraper'] ?? 0) + 1
      } else {
        emailMethod = 'no_website'
        methodCounts['no_website'] = (methodCounts['no_website'] ?? 0) + 1
      }

      // Enrich description, services, social from website
      let enriched = {
        description: '',
        services: '',
        instagram_handle: null as string | null,
        facebook_url: null as string | null,
        other_social: null as string | null,
      }

      if (websiteText) {
        enriched = await extractWebsiteData(websiteText)
      }

      // Fallback: generate best-guess Instagram handle if not found
      if (!enriched.instagram_handle && lead.business_name) {
        const cleanName = lead.business_name.toLowerCase().replace(/[^a-z0-9]/g, '')
        enriched.instagram_handle = `@${cleanName}`
      }

      const { error: updateErr } = await supabase
        .from('leads')
        .update({
          ...(foundEmail && !lead.email ? { email: foundEmail } : {}),
          description: enriched.description || null,
          services: enriched.services || null,
          instagram_handle: enriched.instagram_handle || null,
          facebook_url: enriched.facebook_url || null,
          status: 'researched',
        })
        .eq('id', lead.id)

      if (updateErr) {
        console.error(`[researcher] Lead update failed for "${lead.business_name}": ${updateErr.message}`)
      }

      // Learning log — record method, rounds, outcome for future analysis
      await supabase.from('activity_log').insert({
        event_type: 'lead_researched',
        lead_id: lead.id,
        description: `Researched: ${lead.business_name} | email: ${foundEmail ? 'found' : 'not found'} via ${emailMethod}`,
        metadata: {
          email_found: !!foundEmail,
          email_method: emailMethod,
          email_rounds: emailRounds,
          has_instagram: !!enriched.instagram_handle,
          has_website: !!lead.website,
        },
      })

      processed++
    } catch (error) {
      console.error(`[researcher] Exception for "${lead.business_name}":`, error)

      await supabase.from('activity_log').insert({
        event_type: 'researcher_error',
        lead_id: lead.id,
        description: `Error researching: ${lead.business_name}`,
        metadata: { error: String(error) },
      })

      // Mark researched anyway so the pipeline can continue
      await supabase.from('leads').update({ status: 'researched' }).eq('id', lead.id)
    }
  }

  console.log(`[researcher] Updated ${processed} leads to status=researched`)
  console.log(`[researcher] Done: ${processed} leads processed, ${emailsFound} emails found`)
  console.log(`[researcher] Email method breakdown:`, methodCounts)

  await supabase.from('activity_log').insert({
    event_type: 'researcher_complete',
    description: `Researcher agent completed — ${processed} leads, ${emailsFound} emails found`,
    metadata: { total_processed: processed, emails_found: emailsFound, method_counts: methodCounts },
  })

  return processed
}
