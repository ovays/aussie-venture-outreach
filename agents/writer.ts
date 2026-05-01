import { createServiceClient } from '@/lib/supabase/server'
import { writeOutreachEmail, writeOutreachDM } from '@/lib/claude'
import { emailBodyToHtml } from '@/lib/utils'

export async function runWriterAgent(): Promise<number> {
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

  const { data: leads } = await supabase
    .from('leads')
    .select('*, categories(*)')
    .eq('status', 'researched')

  if (!leads?.length) {
    console.log('No researched leads to write for')
    return 0
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
      }

      // Write DM
      const dmText = await writeOutreachDM({
        business_name: lead.business_name,
        suburb: lead.suburb ?? '',
        city: lead.city,
        category: lead.category_name,
      })

      // Save DM if Instagram handle found
      if (lead.instagram_handle) {
        await supabase.from('dm_queue').insert({
          lead_id: lead.id,
          platform: 'instagram',
          handle: lead.instagram_handle,
          message_text: dmText,
          status: 'pending',
        })
      }

      if (lead.facebook_url) {
        await supabase.from('dm_queue').insert({
          lead_id: lead.id,
          platform: 'facebook',
          handle: lead.facebook_url,
          profile_url: lead.facebook_url,
          message_text: dmText,
          status: 'pending',
        })
      }

      await supabase
        .from('leads')
        .update({ status: 'email_ready' })
        .eq('id', lead.id)

      await supabase.from('activity_log').insert({
        event_type: 'email_written',
        lead_id: lead.id,
        description: `Email written for: ${lead.business_name}`,
        metadata: { has_email: !!lead.email, has_instagram: !!lead.instagram_handle },
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
  return processed
}
