import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createServiceClient } from '@/lib/supabase/server'
import { sendEmail } from '@/lib/resend'
import { fetchPipelineDedupeIndex } from '@/lib/deduplication'
import { researchOneLead, researchPurposeForInitialEmailMode } from '@/lib/research-lead'
import { writeOneLead } from '@/lib/write-lead'
import { handleEmailSyncFailure } from '@/lib/email-status'
import { acquireLock, releaseLock } from '@/lib/distributed-lock'
import { readInitialEmailMode, routeInitialEmail } from '@/lib/initial-email-router'

// Same protection agents/sender.ts (idempotency re-check) and
// resend/route.ts (per-lead lock) already apply to their send paths — this
// bulk action was missing both, so a bulk send racing a concurrent manual
// resend (or a second overlapping bulk request) for the same lead could
// call the Resend API twice for one lead with no DB-level backstop, since
// the common path here UPDATEs an existing pending_send row rather than
// INSERTing (migration 027's unique index only guards INSERTs).
const BULK_SEND_LOCK_TTL_MS = 3 * 60 * 1000

const bulkSchema = z.object({
  action: z.enum(['send_initial_emails', 'delete', 'research_leads']),
  lead_ids: z.array(z.string().uuid()).min(1).max(200),
})

type FailedItem = { lead_id: string; business_name: string; reason: string }

export async function POST(request: NextRequest): Promise<NextResponse> {
  const supabase = createServiceClient()
  const raw = await request.json()

  const parsed = bulkSchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const { action, lead_ids } = parsed.data
  const initialEmailMode = action === 'research_leads' || action === 'send_initial_emails' ? await readInitialEmailMode(supabase) : null

  // ── Send Initial Emails ──────────────────────────────────────────────────────
  if (action === 'send_initial_emails') {
    let sent = 0
    const failed: FailedItem[] = []

    for (const lead_id of lead_ids) {
      const { data: lead } = await supabase
        .from('leads')
        .select('id, business_name, email, status, source, city, category_id, category_name, suburb, website, description, services, content_type')
        .eq('id', lead_id)
        .single()

      if (!lead) {
        failed.push({ lead_id, business_name: lead_id, reason: 'Lead not found' })
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

      const lockKey = `resend:${lead_id}`
      const lockToken = await acquireLock(supabase, lockKey, BULK_SEND_LOCK_TTL_MS)
      if (!lockToken) {
        failed.push({ lead_id, business_name: lead.business_name, reason: 'A send is already in progress for this lead — try again shortly' })
        continue
      }

      try {
        // Idempotency re-check under the lock: catches a send that already
        // completed (via the automated sender agent or another request)
        // between our status read above and now.
        const { data: alreadySent } = await supabase
          .from('emails')
          .select('id')
          .eq('lead_id', lead_id)
          .eq('type', 'initial_pitch')
          .in('status', ['sent', 'email_sync_failed'])
          .limit(1)

        if (alreadySent?.length) {
          failed.push({ lead_id, business_name: lead.business_name, reason: 'Already sent — skipped to avoid duplicate' })
          continue
        }

        let { data: pendingEmail } = await supabase
          .from('emails')
          .select('id, subject, body_html, body_text, generation_source')
          .eq('lead_id', lead_id)
          .eq('type', 'initial_pitch')
          .eq('status', 'pending_send')
          .limit(1)
          .maybeSingle()

        if (!pendingEmail) {
          const generated = await routeInitialEmail(supabase, lead, initialEmailMode!)
          if (!generated.ok) {
            failed.push({ lead_id, business_name: lead.business_name, reason: generated.error.reason })
            continue
          }
          const reload = await supabase.from('emails').select('id, subject, body_html, body_text, generation_source').eq('lead_id', lead_id).eq('type', 'initial_pitch').eq('status', 'pending_send').limit(1).maybeSingle()
          pendingEmail = reload.data
        }
        if (!pendingEmail) {
          failed.push({ lead_id, business_name: lead.business_name, reason: 'No pending Initial Email could be prepared' })
          continue
        }
        const subject = pendingEmail.subject
        const bodyHtml = pendingEmail.body_html
        const bodyText = pendingEmail.body_text ?? ''

        const result = await sendEmail({ to: lead.email, subject, html: bodyHtml, text: bodyText, leadId: lead_id })

        if (!result) {
          failed.push({ lead_id, business_name: lead.business_name, reason: 'Email send failed' })
          continue
        }

        const sentAt = new Date().toISOString()

        const { error: emailUpdateErr } = await supabase.from('emails').update({
          status: 'sent', resend_id: result.id, message_id: result.messageId, sent_at: sentAt,
        }).eq('id', pendingEmail.id)
        if (emailUpdateErr) {
          await handleEmailSyncFailure(supabase, {
            agent:    'bulk-send',
            emailId:  pendingEmail.id,
            leadId:   lead_id,
            resendId: result.id,
            sentAt,
            context: { original_db_error: emailUpdateErr.message, business_name: lead.business_name },
          })
          failed.push({ lead_id, business_name: lead.business_name, reason: `Email delivered but DB update failed — marked Sync Failed` })
          continue
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
      } finally {
        await releaseLock(supabase, lockKey, lockToken)
      }
    }

    return NextResponse.json({ sent, failed })
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

  // ── Research Leads ───────────────────────────────────────────────────────────
  if (action === 'research_leads') {
    let researched = 0
    const failed: FailedItem[] = []

    const dedupeIndex = await fetchPipelineDedupeIndex(supabase)

    for (const lead_id of lead_ids) {
      const { data: lead } = await supabase
        .from('leads')
        .select('*')
        .eq('id', lead_id)
        .single()

      if (!lead) {
        failed.push({ lead_id, business_name: lead_id, reason: 'Lead not found' })
        continue
      }
      if (lead.status !== 'new') {
        failed.push({ lead_id, business_name: lead.business_name, reason: `Status is ${lead.status}, not new` })
        continue
      }

      const researchResult = await researchOneLead(
        supabase,
        lead,
        researchPurposeForInitialEmailMode(initialEmailMode!),
      )
      if (!researchResult.success) {
        failed.push({ lead_id, business_name: lead.business_name, reason: `Research failed: ${researchResult.error}` })
        continue
      }

      // Merge enriched fields so writeOneLead sees the updated email/description/services/instagram
      const enrichedLead = { ...lead, ...researchResult.updatedFields }

      const writeResult = await writeOneLead(supabase, enrichedLead, dedupeIndex, initialEmailMode!)
      if (!writeResult.success) {
        failed.push({ lead_id, business_name: lead.business_name, reason: `Draft generation failed: ${writeResult.error}` })
        continue
      }
      if (writeResult.channel === 'dead') {
        failed.push({ lead_id, business_name: lead.business_name, reason: 'No email found' })
        continue
      }
      if (writeResult.channel === 'duplicate') {
        failed.push({ lead_id, business_name: lead.business_name, reason: 'Duplicate email — skipped' })
        continue
      }

      researched++
    }

    return NextResponse.json({ researched, failed, mode: initialEmailMode })
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
}
