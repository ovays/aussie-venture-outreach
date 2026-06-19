import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createServiceClient } from '@/lib/supabase/server'
import { sendEmail } from '@/lib/resend'
import { writeOutreachEmail } from '@/lib/claude'
import { emailBodyToHtml } from '@/lib/utils'

const bulkSchema = z.object({
  action: z.enum(['send_initial_emails', 'regenerate_drafts', 'delete']),
  lead_ids: z.array(z.string().uuid()).min(1).max(200),
})

const VISIT_ELIGIBLE = [
  'Halal Restaurants', 'Halal Cafes', 'Halal Bakeries / Dessert Shops',
  'Nail Salons', 'Hair Salons', 'Beauty / Lash Studios',
  'Spas / Massage Studios', 'Hotels / Resorts',
]

type FailedItem = { lead_id: string; business_name: string; reason: string }

export async function POST(request: NextRequest): Promise<NextResponse> {
  const supabase = createServiceClient()
  const raw = await request.json()

  const parsed = bulkSchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const { action, lead_ids } = parsed.data

  // ── Send Initial Emails ──────────────────────────────────────────────────────
  if (action === 'send_initial_emails') {
    let sent = 0
    const failed: FailedItem[] = []

    for (const lead_id of lead_ids) {
      const { data: lead } = await supabase
        .from('leads')
        .select('id, business_name, email, status, source, city, category_name, suburb, website, description, services')
        .eq('id', lead_id)
        .single()

      if (!lead) {
        failed.push({ lead_id, business_name: lead_id, reason: 'Lead not found' })
        continue
      }
      if (lead.source === 'manual') {
        failed.push({ lead_id, business_name: lead.business_name, reason: 'Manual leads cannot be bulk sent — use the individual Send button' })
        continue
      }
      if (lead.status !== 'email_ready') {
        failed.push({ lead_id, business_name: lead.business_name, reason: `Status is ${lead.status}, not email_ready` })
        continue
      }
      if (!lead.email) {
        failed.push({ lead_id, business_name: lead.business_name, reason: 'No email address' })
        continue
      }

      const { data: pendingEmail } = await supabase
        .from('emails')
        .select('id, subject, body_html, body_text')
        .eq('lead_id', lead_id)
        .eq('type', 'initial_pitch')
        .eq('status', 'pending_send')
        .limit(1)
        .maybeSingle()

      const subject   = pendingEmail?.subject   ?? `Partnership opportunity — ${lead.business_name}`
      const bodyHtml  = pendingEmail?.body_html  ?? `<p>Hi,</p><p>We would love to work with ${lead.business_name}.</p>`
      const bodyText  = pendingEmail?.body_text  ?? `Hi,\n\nWe would love to work with ${lead.business_name}.\n\nBest,\nOwais`

      try {
        const result = await sendEmail({ to: lead.email, subject, html: bodyHtml, text: bodyText, leadId: lead_id })

        if (!result) {
          failed.push({ lead_id, business_name: lead.business_name, reason: 'Email send failed' })
          continue
        }

        const sentAt = new Date().toISOString()

        if (pendingEmail?.id) {
          await supabase.from('emails').update({
            status: 'sent', resend_id: result.id, sent_at: sentAt,
          }).eq('id', pendingEmail.id)
        } else {
          await supabase.from('emails').insert({
            lead_id, type: 'initial_pitch', subject, body_html: bodyHtml, body_text: bodyText,
            status: 'sent', resend_id: result.id, sent_at: sentAt,
          })
        }

        await supabase.from('leads').update({ status: 'contacted', updated_at: sentAt }).eq('id', lead_id)
        await supabase.from('activity_log').insert({
          event_type: 'email_sent',
          lead_id,
          description: `Email sent to ${lead.business_name} (${lead.email}) via bulk send`,
          metadata: { resend_id: result.id, subject, bulk: true },
        })

        sent++
      } catch (err) {
        failed.push({
          lead_id,
          business_name: lead.business_name,
          reason: err instanceof Error ? err.message : 'Unknown error',
        })
      }
    }

    return NextResponse.json({ sent, failed })
  }

  // ── Regenerate Drafts ────────────────────────────────────────────────────────
  if (action === 'regenerate_drafts') {
    let regenerated = 0
    const failed: FailedItem[] = []

    for (const lead_id of lead_ids) {
      const { data: lead } = await supabase
        .from('leads')
        .select('id, business_name, category_name, suburb, city, website, description, services, email, status')
        .eq('id', lead_id)
        .single()

      if (!lead || !['email_ready', 'researched'].includes(lead.status)) {
        failed.push({ lead_id, business_name: lead?.business_name ?? lead_id, reason: 'Invalid status for regeneration' })
        continue
      }

      try {
        // Delete existing pending draft so we can regenerate it
        await supabase.from('emails').delete()
          .eq('lead_id', lead_id)
          .eq('type', 'initial_pitch')
          .eq('status', 'pending_send')

        const contentType = (lead.city?.toLowerCase() === 'sydney' && VISIT_ELIGIBLE.includes(lead.category_name))
          ? 'visit' : 'remote'

        const emailResult = await writeOutreachEmail({
          business_name: lead.business_name,
          category:      lead.category_name,
          suburb:        lead.suburb ?? '',
          city:          lead.city,
          website:       lead.website ?? '',
          description:   lead.description ?? '',
          services:      lead.services ?? '',
          content_type:  contentType,
        })

        await supabase.from('emails').insert({
          lead_id,
          type:      'initial_pitch',
          subject:   emailResult.subject,
          body_html: emailBodyToHtml(emailResult.body),
          body_text: emailResult.body,
          status:    'pending_send',
        })

        await supabase.from('leads').update({ status: 'email_ready' }).eq('id', lead_id)
        regenerated++
      } catch (err) {
        failed.push({
          lead_id,
          business_name: lead.business_name,
          reason: err instanceof Error ? err.message : 'Unknown error',
        })
      }
    }

    return NextResponse.json({ regenerated, failed })
  }

  // ── Delete ───────────────────────────────────────────────────────────────────
  if (action === 'delete') {
    let deleted = 0
    const failed: Array<{ lead_id: string; reason: string }> = []

    for (const lead_id of lead_ids) {
      try {
        await supabase.from('follow_ups').delete().eq('lead_id', lead_id)
        await supabase.from('dm_queue').delete().eq('lead_id', lead_id)
        await supabase.from('deals').delete().eq('lead_id', lead_id)
        await supabase.from('activity_log').delete().eq('lead_id', lead_id)
        await supabase.from('emails').delete().eq('lead_id', lead_id)
        const { error } = await supabase.from('leads').delete().eq('id', lead_id)
        if (error) failed.push({ lead_id, reason: error.message })
        else deleted++
      } catch (err) {
        failed.push({ lead_id, reason: err instanceof Error ? err.message : 'Unknown error' })
      }
    }

    return NextResponse.json({ deleted, failed })
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
}
