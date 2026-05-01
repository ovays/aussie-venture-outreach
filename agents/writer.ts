import { createServiceClient } from '@/lib/supabase/server'
import { writeOutreachEmail, writeOutreachDM } from '@/lib/claude'
import { emailBodyToHtml } from '@/lib/utils'

export async function runWriterAgent(): Promise<void> {
  const supabase = createServiceClient()

  const { data: systemSetting } = await supabase
    .from('settings')
    .select('value')
    .eq('key', 'system_active')
    .single()

  if (systemSetting?.value !== 'true') {
    console.log('System is paused. Writer agent skipped.')
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
      console.log(`[writer] Resetting ${toReset.length} stale email_ready leads to researched`)
      await supabase.from('leads').update({ status: 'researched' }).in('id', toReset)
    }
  }

  // Fetch all researched leads (includes any just reset above)
  const { data: leads } = await supabase
    .from('leads')
    .select('*, categories(*)')
    .eq('status', 'researched')

  if (!leads?.length) {
    console.log('No researched leads to write for')
    return
  }

  let processed = 0

  for (const lead of leads) {
    try {
      // Visit only when business is in Sydney AND category supports in-person content
      const VISIT_ELIGIBLE = [
        'Halal Restaurants', 'Halal Cafes', 'Halal Bakeries / Dessert Shops',
        'Nail Salons', 'Hair Salons', 'Beauty / Lash Studios',
        'Spas / Massage Studios', 'Hotels / Resorts',
      ]
      const isSydney = lead.city?.toLowerCase() === 'sydney'
      const contentType = (isSydney && VISIT_ELIGIBLE.includes(lead.category_name)) ? 'visit' : 'remote'

      // Write email
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

      const bodyHtml = emailBodyToHtml(emailResult.body)

      let emailInserted = false
      let dmInserted = false

      // Save email
      if (lead.email) {
        await supabase.from('emails').insert({
          lead_id: lead.id,
          type: 'initial_pitch',
          subject: emailResult.subject,
          body_html: bodyHtml,
          body_text: emailResult.body,
          status: 'pending_send',
        })
        emailInserted = true
      } else {
        console.log(`[writer] No email address for lead ${lead.business_name} — skipping email insert`)
      }

      // Write DM
      const dmText = await writeOutreachDM({
        business_name: lead.business_name,
        suburb: lead.suburb ?? '',
        city: lead.city,
        category: lead.category_name,
      })

      // Save DM if Instagram handle found and under daily limit
      if (lead.instagram_handle && dmsAddedToday < dailyDmLimit) {
        await supabase.from('dm_queue').insert({
          lead_id: lead.id,
          platform: 'instagram',
          handle: lead.instagram_handle,
          message_text: dmText,
          status: 'pending',
        })
        dmInserted = true
        dmsAddedToday++
      }

      if (lead.facebook_url && dmsAddedToday < dailyDmLimit) {
        await supabase.from('dm_queue').insert({
          lead_id: lead.id,
          platform: 'facebook',
          handle: lead.facebook_url,
          profile_url: lead.facebook_url,
          message_text: dmText,
          status: 'pending',
        })
        dmInserted = true
        dmsAddedToday++
      }

      const newStatus = emailInserted ? 'email_ready' : dmInserted ? 'dm_only' : 'no_contact'

      await supabase
        .from('leads')
        .update({ status: newStatus })
        .eq('id', lead.id)

      await supabase.from('activity_log').insert({
        event_type: 'email_written',
        lead_id: lead.id,
        description: `Outreach written for: ${lead.business_name} (${newStatus})`,
        metadata: { has_email: emailInserted, has_instagram: !!lead.instagram_handle, status: newStatus },
      })

      processed++
    } catch (error) {
      await supabase.from('activity_log').insert({
        event_type: 'writer_error',
        lead_id: lead.id,
        description: `Error writing for: ${lead.business_name}`,
        metadata: { error: String(error) },
      })
    }
  }

  await supabase.from('activity_log').insert({
    event_type: 'writer_complete',
    description: `Writer agent completed: ${processed} emails written`,
    metadata: { total_processed: processed },
  })

  console.log(`Writer agent done: ${processed} emails written`)
}
