import { createServiceClient } from '@/lib/supabase/server'
import { extractWebsiteData } from '@/lib/claude'

async function fetchRawHtml(url: string): Promise<string> {
  const normalised = url.startsWith('http') ? url : `https://${url}`
  const response = await fetch(normalised, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AussieVentureBot/1.0)' },
    signal: AbortSignal.timeout(10_000),
  })
  return response.text()
}

function extractEmailFromHtml(html: string): string | null {
  // mailto: links are most reliable
  const mailtoMatch = html.match(/href=["']mailto:([^"'?\s]+)/i)
  if (mailtoMatch?.[1]?.includes('@')) return mailtoMatch[1]

  // Scan for all email-like tokens
  const emailPattern = /\b[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}\b/g
  const matches = html.match(emailPattern) ?? []

  const valid = matches.filter(e =>
    e.length < 80 &&
    !e.includes('example.') &&
    !e.includes('sentry.') &&
    !e.includes('wixpress.') &&
    !e.includes('@2x') &&
    !/\.(png|jpg|gif|svg|webp|css|js)$/.test(e)
  )

  // Prefer common contact-style prefixes
  const preferred = valid.find(e =>
    /^(info|contact|hello|enquir|admin|support|booking|reservation|mail)@/i.test(e)
  )
  return preferred ?? valid[0] ?? null
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
      let foundEmail: string | null = null

      if (lead.website) {
        try {
          const html = await fetchRawHtml(lead.website)

          // Extract email from raw HTML before stripping tags
          if (!lead.email) {
            foundEmail = extractEmailFromHtml(html)

            // If not on main page, try /contact
            if (!foundEmail) {
              try {
                const base = new URL(lead.website.startsWith('http') ? lead.website : `https://${lead.website}`)
                const contactHtml = await fetchRawHtml(`${base.origin}/contact`)
                foundEmail = extractEmailFromHtml(contactHtml)
              } catch {
                // contact page may not exist
              }
            }
          }

          websiteContent = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 5000)
        } catch {
          // site unreachable
        }
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

      // If Instagram not found on website, generate a best-guess handle
      if (!enriched.instagram_handle && lead.business_name) {
        const cleanName = lead.business_name.toLowerCase().replace(/[^a-z0-9]/g, '')
        enriched.instagram_handle = `@${cleanName}`
      }

      await supabase
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

      await supabase.from('activity_log').insert({
        event_type: 'lead_researched',
        lead_id: lead.id,
        description: `Researched: ${lead.business_name}`,
        metadata: { has_instagram: !!enriched.instagram_handle, email_found: !!foundEmail },
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
