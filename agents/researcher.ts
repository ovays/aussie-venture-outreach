import { createServiceClient } from '@/lib/supabase/server'
import { extractWebsiteData, agenticEmailSearch } from '@/lib/claude'

// ── Mailto-first email extraction (same logic as finder.ts) ─────────────────

const MAILTO_RE = /href=["']mailto:([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/gi
const EMAIL_RE  = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g
const BLOCKED_LOCALS = new Set([
  'noreply', 'donotreply', 'no-reply', 'wordpress',
  'postmaster', 'webmaster', 'bounce', 'mailer',
])

function isCleanEmail(email: string): boolean {
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

function extractMailtoEmail(html: string): string | null {
  // Always check mailto: links FIRST — avoids false positives from link text like "thello@..."
  const re = new RegExp(MAILTO_RE.source, 'gi')
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    if (isCleanEmail(m[1])) return m[1]
  }
  // Fall back to full-HTML regex only if no mailto found
  const matches = html.match(EMAIL_RE) ?? []
  return matches.find(isCleanEmail) ?? null
}

// ── Website fetcher ──────────────────────────────────────────────────────────

async function fetchRawHtml(url: string): Promise<string> {
  const normalised = url.startsWith('http') ? url : `https://${url}`
  const res = await fetch(normalised, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AussieVentureBot/1.0)' },
    signal: AbortSignal.timeout(10_000),
  })
  return res.text()
}

// ── Bounced email fixer ──────────────────────────────────────────────────────

async function fixBouncedEmails(supabase: ReturnType<typeof createServiceClient>): Promise<void> {
  const { data: bouncedEmails } = await supabase
    .from('emails')
    .select('id, lead_id, leads(id, email, website, business_name)')
    .eq('status', 'bounced')

  if (!bouncedEmails?.length) {
    console.log('[researcher] No bounced emails to fix')
    return
  }

  console.log(`[researcher] Found ${bouncedEmails.length} bounced email(s) — attempting to re-extract`)

  for (const emailRecord of bouncedEmails) {
    const lead = emailRecord.leads as unknown as { id: string; email: string | null; website: string | null; business_name: string } | null
    if (!lead?.website) continue

    try {
      let html = await fetchRawHtml(lead.website)
      let newEmail = extractMailtoEmail(html)

      // Try /contact page if homepage didn't yield anything
      if (!newEmail) {
        const base = lead.website.replace(/\/$/, '')
        html = await fetchRawHtml(`${base}/contact`).catch(() => '')
        newEmail = html ? extractMailtoEmail(html) : null
      }

      if (!newEmail || newEmail === lead.email) continue

      console.log(`[researcher] Fixed bounced email for ${lead.business_name}: ${lead.email} → ${newEmail}`)

      await supabase.from('leads').update({ email: newEmail }).eq('id', lead.id)
      await supabase.from('emails').update({ status: 'pending_send' }).eq('id', emailRecord.id)

      await supabase.from('activity_log').insert({
        event_type: 'email_fixed',
        lead_id: lead.id,
        description: `Bounced email corrected for ${lead.business_name}: ${lead.email} → ${newEmail}`,
        metadata: { old_email: lead.email, new_email: newEmail },
      })
    } catch (err) {
      console.error(`[researcher] Error fixing bounced email for lead_id=${emailRecord.lead_id}:`, err)
    }
  }
}

export async function runResearcherAgent(): Promise<number> {
  const supabase = createServiceClient()

  try {
  const { data: systemSetting } = await supabase
    .from('settings')
    .select('value')
    .eq('key', 'system_active')
    .single()

  if (systemSetting?.value !== 'true') {
    console.log('System is paused - Researcher agent skipped')
    return 0
  }

  // Fix any bounced emails from previous sends before processing new leads
  await fixBouncedEmails(supabase)

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

      // Mailto-first extraction — cheaper than Claude, catches most real emails
      if (!foundEmail && rawHtml) {
        const mailtoEmail = extractMailtoEmail(rawHtml)
        if (mailtoEmail) {
          foundEmail = mailtoEmail
          emailMethod = 'mailto_link'
          emailsFound++
          console.log(`[researcher] Found email via mailto: for "${lead.business_name}": ${mailtoEmail}`)
        }
      }

      // Agentic email search — only if mailto didn't find anything and we have website text
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

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[researcher] Fatal error:', error)
    await supabase.from('activity_log').insert({
      event_type: 'agent_error',
      description: `Agent failed: ${message}`,
      metadata: {
        agent: 'researcher',
        error: message,
        stack: error instanceof Error ? error.stack : null,
        timestamp: new Date().toISOString(),
      },
    })
    throw error
  }
}
