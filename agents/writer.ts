import { createServiceClient } from '@/lib/supabase/server'
import { writeOutreachEmail, writeOutreachDM } from '@/lib/claude'
import { emailBodyToHtml } from '@/lib/utils'

export async function runWriterAgent(): Promise<void> {
  console.log('[writer] Writer agent starting...')

  const supabase = createServiceClient()

  const { data: systemSetting, error: settingErr } = await supabase
    .from('settings')
    .select('value')
    .eq('key', 'system_active')
    .single()

  console.log(`[writer] system_active = "${systemSetting?.value}" (err: ${settingErr?.message ?? 'none'})`)

  if (systemSetting?.value !== 'true') {
    console.log('[writer] System is paused — writer skipped')
    return
  }

  // Read daily DM limit
  const { data: dmLimitSetting } = await supabase
    .from('settings')
    .select('value')
    .eq('key', 'daily_dm_limit')
    .single()

  const dailyDmLimit = parseInt(dmLimitSetting?.value ?? '10', 10)

  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)
  const { count: todayDmCount } = await supabase
    .from('dm_queue')
    .select('*', { count: 'exact', head: true })
    .gte('created_at', todayStart.toISOString())

  let dmsAddedToday = todayDmCount ?? 0
  console.log(`[writer] DM limit: ${dailyDmLimit}, already queued today: ${dmsAddedToday}`)

  // Reset stale email_ready leads (no pending_send email) back to researched so they reprocess
  const { data: emailReadyLeads } = await supabase
    .from('leads')
    .select('id')
    .eq('status', 'email_ready')

  if (emailReadyLeads?.length) {
    const emailReadyIds = emailReadyLeads.map((l: { id: string }) => l.id)
    const { data: emailsWithPending } = await supabase
      .from('emails')
      .select('lead_id')
      .in('lead_id', emailReadyIds)
      .eq('status', 'pending_send')

    const withPendingSet = new Set(emailsWithPending?.map((e: { lead_id: string }) => e.lead_id) ?? [])
    const toReset = emailReadyIds.filter((id: string) => !withPendingSet.has(id))

    if (toReset.length) {
      console.log(`[writer] Resetting ${toReset.length} stale email_ready leads back to researched`)
      const { error: resetErr } = await supabase.from('leads').update({ status: 'researched' }).in('id', toReset)
      if (resetErr) console.error('[writer] Reset error:', resetErr.message)
    }
  }

  // Fetch all researched leads (includes any just reset above)
  const { data: leads, error: leadsErr } = await supabase
    .from('leads')
    .select('*, categories(*)')
    .eq('status', 'researched')

  if (leadsErr) console.error('[writer] Error fetching researched leads:', leadsErr.message)

  if (!leads?.length) {
    console.log('[writer] No researched leads found — nothing to process')
    return
  }

  console.log(`[writer] Found ${leads.length} researched leads to process`)
  console.log(`[writer] Leads with email: ${leads.filter(l => l.email).length} / ${leads.length}`)

  let processed = 0
  let emailsQueued = 0
  let emailsSkipped = 0
  let dmsQueued = 0

  for (const lead of leads) {
    console.log(`[writer] Processing: "${lead.business_name}" | email: ${lead.email ?? 'NONE'} | id: ${lead.id}`)

    try {
      const VISIT_ELIGIBLE = [
        'Halal Restaurants', 'Halal Cafes', 'Halal Bakeries / Dessert Shops',
        'Nail Salons', 'Hair Salons', 'Beauty / Lash Studios',
        'Spas / Massage Studios', 'Hotels / Resorts',
      ]
      const isSydney = lead.city?.toLowerCase() === 'sydney'
      const contentType = (isSydney && VISIT_ELIGIBLE.includes(lead.category_name)) ? 'visit' : 'remote'

      // Write email content
      const emailResult = await writeOutreachEmail({
        business_name: lead.business_name,
        category: lead.category_name,
        suburb: lead.suburb ?? '',
        city: lead.city,
        website: lead.website ?? '',
        description: lead.description ?? '',
        services: lead.services ?? '',
        content_type: contentType,
      })

      console.log(`[writer] Email generated for "${lead.business_name}" — subject: "${emailResult.subject}" | body length: ${emailResult.body?.length ?? 0}`)

      const bodyHtml = emailBodyToHtml(emailResult.body)

      let emailInserted = false
      let dmInserted = false

      // Insert email row if lead has an address
      if (lead.email) {
        const { error: insertErr } = await supabase.from('emails').insert({
          lead_id: lead.id,
          type: 'initial_pitch',
          subject: emailResult.subject,
          body_html: bodyHtml,
          body_text: emailResult.body,
          status: 'pending_send',
        })

        if (insertErr) {
          console.error(`[writer] EMAIL INSERT FAILED for "${lead.business_name}" (${lead.email}): ${insertErr.message} | code: ${insertErr.code}`)
        } else {
          console.log(`[writer] Email inserted OK for "${lead.business_name}" (${lead.email})`)
          emailInserted = true
          emailsQueued++
        }
      } else {
        console.log(`[writer] SKIP email — no address for: "${lead.business_name}"`)
        emailsSkipped++
      }

      // Write DM content
      const dmText = await writeOutreachDM({
        business_name: lead.business_name,
        suburb: lead.suburb ?? '',
        city: lead.city,
        category: lead.category_name,
      })

      // Queue Instagram DM if within daily limit
      if (lead.instagram_handle && dmsAddedToday < dailyDmLimit) {
        const { error: igErr } = await supabase.from('dm_queue').insert({
          lead_id: lead.id,
          platform: 'instagram',
          handle: lead.instagram_handle,
          message_text: dmText,
          status: 'pending',
        })
        if (igErr) {
          console.error(`[writer] DM insert (instagram) failed for "${lead.business_name}": ${igErr.message}`)
        } else {
          dmInserted = true
          dmsAddedToday++
          dmsQueued++
        }
      }

      // Queue Facebook DM if within daily limit
      if (lead.facebook_url && dmsAddedToday < dailyDmLimit) {
        const { error: fbErr } = await supabase.from('dm_queue').insert({
          lead_id: lead.id,
          platform: 'facebook',
          handle: lead.facebook_url,
          profile_url: lead.facebook_url,
          message_text: dmText,
          status: 'pending',
        })
        if (fbErr) {
          console.error(`[writer] DM insert (facebook) failed for "${lead.business_name}": ${fbErr.message}`)
        } else {
          dmInserted = true
          dmsAddedToday++
          dmsQueued++
        }
      }

      // Use only statuses the leads table CHECK constraint allows
      // 'email_ready' = email queued | 'researched' = only DM queued or nothing (stays for retry)
      const newStatus = emailInserted ? 'email_ready' : 'researched'

      const { error: statusErr } = await supabase
        .from('leads')
        .update({ status: newStatus })
        .eq('id', lead.id)

      if (statusErr) {
        console.error(`[writer] Status update failed for "${lead.business_name}": ${statusErr.message}`)
      } else {
        console.log(`[writer] Lead "${lead.business_name}" → status: ${newStatus}`)
      }

      const { error: logErr } = await supabase.from('activity_log').insert({
        event_type: 'email_written',
        lead_id: lead.id,
        description: `Outreach written for: ${lead.business_name} (${newStatus})`,
        metadata: { has_email: emailInserted, has_instagram: !!lead.instagram_handle, status: newStatus },
      })
      if (logErr) console.error(`[writer] activity_log insert failed: ${logErr.message}`)

      processed++
    } catch (error) {
      console.error(`[writer] EXCEPTION for "${lead.business_name}":`, error)
      await supabase.from('activity_log').insert({
        event_type: 'writer_error',
        lead_id: lead.id,
        description: `Error writing for: ${lead.business_name}`,
        metadata: { error: String(error) },
      })
    }
  }

  console.log(`[writer] Summary: ${emailsQueued} emails queued, ${emailsSkipped} skipped (no address), ${dmsQueued} DMs queued`)

  await supabase.from('activity_log').insert({
    event_type: 'writer_complete',
    description: `Writer agent completed: ${emailsQueued} emails queued, ${emailsSkipped} skipped, ${dmsQueued} DMs queued`,
    metadata: { total_processed: processed, emails_queued: emailsQueued, emails_skipped: emailsSkipped, dms_queued: dmsQueued },
  })

  console.log(`[writer] Done: ${processed} leads processed`)
}
