import { createServiceClient } from '@/lib/supabase/server'
import { extractWebsiteData, extractEmailWithHaiku } from '@/lib/claude'

const EMAIL_REGEX = /[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}/gi

async function fetchText(url: string): Promise<string> {
  try {
    const normalised = url.startsWith('http') ? url : `https://${url}`
    const res = await fetch(normalised, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AussieVentureBot/1.0)' },
      signal: AbortSignal.timeout(10_000),
    })
    const html = await res.text()
    return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 5000)
  } catch {
    return ''
  }
}

function firstValidEmail(text: string): string | null {
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

interface EnrichedLead {
  email: string | null
  emailMethod: string
  instagramHandle: string | null
  facebookUrl: string | null
  description: string
  services: string
}

async function enrichLead(lead: {
  id: string
  business_name: string
  email?: string | null
  website?: string | null
  suburb?: string | null
}): Promise<EnrichedLead> {
  // 1. Outscraper email (already in DB)
  if (lead.email) {
    return {
      email: lead.email,
      emailMethod: 'outscraper',
      instagramHandle: null,
      facebookUrl: null,
      description: '',
      services: '',
    }
  }

  if (!lead.website) {
    return { email: null, emailMethod: 'no_website', instagramHandle: null, facebookUrl: null, description: '', services: '' }
  }

  // 2. Fetch homepage
  const homepageText = await fetchText(lead.website)
  let email = firstValidEmail(homepageText)

  // Extract social + description from homepage (Haiku call — cheap)
  let instagramHandle: string | null = null
  let facebookUrl: string | null = null
  let description = ''
  let services = ''

  if (homepageText) {
    try {
      const enriched = await extractWebsiteData(homepageText)
      instagramHandle = enriched.instagram_handle
      facebookUrl = enriched.facebook_url
      description = enriched.description
      services = enriched.services
    } catch {}
  }

  if (email) {
    return { email, emailMethod: 'homepage_regex', instagramHandle, facebookUrl, description, services }
  }

  // 3. Try /contact page
  try {
    const base = new URL(lead.website.startsWith('http') ? lead.website : `https://${lead.website}`)
    const contactText = await fetchText(`${base.origin}/contact`)

    email = firstValidEmail(contactText)
    if (email) {
      return { email, emailMethod: 'contact_regex', instagramHandle, facebookUrl, description, services }
    }

    // 4. Claude Haiku extraction on combined content
    const combined = `${homepageText}\n${contactText}`.slice(0, 5000)
    const haikuEmail = await extractEmailWithHaiku(combined, lead.business_name)
    if (haikuEmail) {
      return { email: haikuEmail, emailMethod: 'haiku', instagramHandle, facebookUrl, description, services }
    }
  } catch {}

  return { email: null, emailMethod: 'not_found', instagramHandle, facebookUrl, description, services }
}

async function findInstagramOnly(lead: {
  website?: string | null
}): Promise<{ instagramHandle: string | null; facebookUrl: string | null; description: string; services: string }> {
  if (!lead.website) return { instagramHandle: null, facebookUrl: null, description: '', services: '' }

  const homepageText = await fetchText(lead.website)
  if (!homepageText) return { instagramHandle: null, facebookUrl: null, description: '', services: '' }

  try {
    const enriched = await extractWebsiteData(homepageText)
    return {
      instagramHandle: enriched.instagram_handle,
      facebookUrl: enriched.facebook_url,
      description: enriched.description,
      services: enriched.services,
    }
  } catch {
    return { instagramHandle: null, facebookUrl: null, description: '', services: '' }
  }
}

export async function runEnricherAgent(): Promise<number> {
  const supabase = createServiceClient()

  const { data: systemSetting } = await supabase
    .from('settings')
    .select('value')
    .eq('key', 'system_active')
    .single()

  if (systemSetting?.value !== 'true') {
    console.log('System is paused - Enricher agent skipped')
    return 0
  }

  // Read quota targets
  const [emailLimitRow, dmLimitRow, leadLimitRow] = await Promise.all([
    supabase.from('settings').select('value').eq('key', 'daily_email_limit').single(),
    supabase.from('settings').select('value').eq('key', 'daily_dm_limit').single(),
    supabase.from('settings').select('value').eq('key', 'daily_lead_limit').single(),
  ])

  const EMAIL_TARGET = parseInt(emailLimitRow.data?.value ?? '30', 10)
  const INSTA_TARGET = parseInt(dmLimitRow.data?.value ?? '10', 10)
  const TOTAL_TARGET = parseInt(leadLimitRow.data?.value ?? '50', 10)

  console.log(`[enricher] Targets — email: ${EMAIL_TARGET}, instagram: ${INSTA_TARGET}, total: ${TOTAL_TARGET}`)

  // Read all 'new' leads, highest rated first
  const { data: pool } = await supabase
    .from('leads')
    .select('*')
    .eq('status', 'new')
    .order('google_rating', { ascending: false, nullsFirst: false })
    .order('google_reviews_count', { ascending: false, nullsFirst: false })

  if (!pool?.length) {
    console.log('[enricher] No new leads in pool')
    return 0
  }

  console.log(`[enricher] Pool: ${pool.length} candidates to process`)

  const emailLeadIds: string[] = []
  const instaLeadIds: string[] = []
  const overflowIds: string[] = []

  for (const lead of pool) {
    const emailFull = emailLeadIds.length >= EMAIL_TARGET
    const instaFull = instaLeadIds.length >= INSTA_TARGET
    const totalFull = emailLeadIds.length + instaLeadIds.length >= TOTAL_TARGET

    // Quotas met — pool overflow, delete these candidates so finder re-discovers next run
    if ((emailFull && instaFull) || totalFull) {
      overflowIds.push(lead.id)
      continue
    }

    try {
      if (!emailFull) {
        // Email path — try to find a contact email
        const found = await enrichLead(lead)

        if (found.email) {
          await supabase.from('leads').update({
            email: found.email,
            instagram_handle: found.instagramHandle || null,
            facebook_url: found.facebookUrl || null,
            description: found.description || null,
            services: found.services || null,
            status: 'researched',
            outreach_channel: 'email',
          }).eq('id', lead.id)

          emailLeadIds.push(lead.id)
          console.log(`✅ Email lead: "${lead.business_name}" — ${found.email} (${found.emailMethod})`)

          await supabase.from('activity_log').insert({
            event_type: 'lead_enriched',
            lead_id: lead.id,
            description: `Email found: ${lead.business_name} — ${found.email} via ${found.emailMethod}`,
            metadata: { type: 'email', method: found.emailMethod, email: found.email },
          })
        } else {
          // No email and email bucket not full → dead
          await supabase.from('leads').update({ status: 'dead' }).eq('id', lead.id)
          console.log(`❌ Skipped (no email): "${lead.business_name}"`)
        }
      } else {
        // Email bucket full — Instagram fallback mode
        const found = await findInstagramOnly(lead)

        if (found.instagramHandle || found.facebookUrl) {
          await supabase.from('leads').update({
            instagram_handle: found.instagramHandle || null,
            facebook_url: found.facebookUrl || null,
            description: found.description || null,
            services: found.services || null,
            status: 'researched',
            outreach_channel: 'instagram',
          }).eq('id', lead.id)

          instaLeadIds.push(lead.id)
          console.log(`📱 Instagram lead: "${lead.business_name}" — ${found.instagramHandle ?? found.facebookUrl}`)

          await supabase.from('activity_log').insert({
            event_type: 'lead_enriched',
            lead_id: lead.id,
            description: `Instagram found: ${lead.business_name} — ${found.instagramHandle ?? found.facebookUrl}`,
            metadata: { type: 'instagram', instagram: found.instagramHandle, facebook: found.facebookUrl },
          })
        } else {
          await supabase.from('leads').update({ status: 'dead' }).eq('id', lead.id)
          console.log(`❌ Skipped (no Instagram): "${lead.business_name}"`)
        }
      }
    } catch (error) {
      console.error(`[enricher] Exception for "${lead.business_name}":`, error)
      await supabase.from('leads').update({ status: 'dead' }).eq('id', lead.id)
    }
  }

  // Delete pool overflow candidates so finder can re-discover them next run
  if (overflowIds.length) {
    await supabase.from('leads').delete().in('id', overflowIds)
    console.log(`[enricher] Deleted ${overflowIds.length} pool overflow candidates (will be re-discovered)`)
  }

  const total = emailLeadIds.length + instaLeadIds.length
  console.log(`[enricher] Done — Email leads: ${emailLeadIds.length}/${EMAIL_TARGET}, Instagram leads: ${instaLeadIds.length}/${INSTA_TARGET}`)

  await supabase.from('activity_log').insert({
    event_type: 'enricher_complete',
    description: `Enricher complete — ${emailLeadIds.length} email leads, ${instaLeadIds.length} instagram leads`,
    metadata: {
      email_leads: emailLeadIds.length,
      insta_leads: instaLeadIds.length,
      overflow_deleted: overflowIds.length,
      email_target: EMAIL_TARGET,
      insta_target: INSTA_TARGET,
    },
  })

  return total
}
