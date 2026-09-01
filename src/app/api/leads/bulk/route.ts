import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { sendEmail } from '@/lib/resend'
import { fetchPipelineDedupeIndex } from '@/lib/deduplication'
import { researchOneLead, researchPurposeForInitialEmailMode } from '@/lib/research-lead'
import { writeOneLead } from '@/lib/write-lead'
import { handleEmailSyncFailure } from '@/lib/email-status'
import { acquireLock, releaseLock } from '@/lib/distributed-lock'
import { readInitialEmailMode, routeInitialEmail } from '@/lib/initial-email-router'
import { leadsBulkRequestSchema } from '@/lib/leads-bulk-request'
import { processResearchedLead } from '@/lib/process-researched-lead'
import {
  summarizeLeadsBulkOutcomes,
  type LeadsBulkOutcome,
} from '@/lib/leads-bulk-progress'
import { isDeliverySuppressedForAddress } from '@/lib/delivery-suppression'
import { claimRecipientOutreach } from '@/lib/data-quality'

// Same protection agents/sender.ts (idempotency re-check) and
// resend/route.ts (per-lead lock) already apply to their send paths — this
// bulk action was missing both, so a bulk send racing a concurrent manual
// resend (or a second overlapping bulk request) for the same lead could
// call the Resend API twice for one lead with no DB-level backstop, since
// the common path here UPDATEs an existing pending_send row rather than
// INSERTing (migration 027's unique index only guards INSERTs).
const BULK_SEND_LOCK_TTL_MS = 3 * 60 * 1000

type FailedItem = { lead_id: string; business_name: string; reason: string }

export async function GET(): Promise<NextResponse> {
  const supabase = createServiceClient()
  const initialEmailMode = await readInitialEmailMode(supabase)
  return NextResponse.json({ initial_email_mode: initialEmailMode })
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const supabase = createServiceClient()
  const raw = await request.json()

  const parsed = leadsBulkRequestSchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const { action, lead_ids, initial_email_mode: suppliedInitialEmailMode } = parsed.data
  const initialEmailMode = action === 'research_leads' || action === 'process_researched_leads' || action === 'send_initial_emails'
    ? suppliedInitialEmailMode ?? await readInitialEmailMode(supabase)
    : null

  // ── Send Initial Emails ──────────────────────────────────────────────────────
  if (action === 'send_initial_emails') {
    let sent = 0
    const failed: FailedItem[] = []
    const skipped: FailedItem[] = []
    const outcomes: LeadsBulkOutcome[] = []

    for (const lead_id of lead_ids) {
      const { data: lead } = await supabase
        .from('leads')
        .select('id, business_name, email, status, source, city, category_id, category_name, suburb, website, description, services, content_type, delivery_suppressed_emails')
        .eq('id', lead_id)
        .single()

      if (!lead) {
        const failure = { lead_id, business_name: lead_id, reason: 'Lead not found' }
        failed.push(failure)
        outcomes.push({ ...failure, status: 'failed' })
        continue
      }
      if (lead.status !== 'email_ready') {
        const skip = { lead_id, business_name: lead.business_name, reason: `Status is ${lead.status}, not email_ready` }
        skipped.push(skip)
        outcomes.push({ ...skip, status: 'skipped' })
        continue
      }
      if (!lead.email) {
        const skip = { lead_id, business_name: lead.business_name, reason: 'No email address' }
        skipped.push(skip)
        outcomes.push({ ...skip, status: 'skipped' })
        continue
      }
      if (isDeliverySuppressedForAddress(lead.email, lead.delivery_suppressed_emails)) {
        const skip = { lead_id, business_name: lead.business_name, reason: 'Current email has a terminal delivery failure' }
        skipped.push(skip)
        outcomes.push({ ...skip, status: 'skipped' })
        continue
      }

      const lockKey = `resend:${lead_id}`
      const lockToken = await acquireLock(supabase, lockKey, BULK_SEND_LOCK_TTL_MS)
      if (!lockToken) {
        const skip = { lead_id, business_name: lead.business_name, reason: 'A send is already in progress for this lead — skipped to avoid duplicate delivery' }
        skipped.push(skip)
        outcomes.push({ ...skip, status: 'skipped' })
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
          const skip = { lead_id, business_name: lead.business_name, reason: 'Already sent — skipped to avoid duplicate delivery' }
          skipped.push(skip)
          outcomes.push({ ...skip, status: 'skipped' })
          continue
        }

        const ownership = await claimRecipientOutreach(supabase, lead_id, 'initial')
        if (!ownership.allowed) {
          const skip = { lead_id, business_name: lead.business_name, reason: ownership.reason === 'email_already_contacted' ? 'Email already contacted through another lead' : `Recipient suppressed: ${ownership.reason ?? 'data quality'}` }
          skipped.push(skip)
          outcomes.push({ ...skip, status: 'skipped' })
          await supabase.from('emails').update({ status: 'failed' }).eq('lead_id', lead_id).eq('type', 'initial_pitch').eq('status', 'pending_send')
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
            const failure = { lead_id, business_name: lead.business_name, reason: generated.error.reason }
            failed.push(failure)
            outcomes.push({ ...failure, status: 'failed' })
            continue
          }
          const reload = await supabase.from('emails').select('id, subject, body_html, body_text, generation_source').eq('lead_id', lead_id).eq('type', 'initial_pitch').eq('status', 'pending_send').limit(1).maybeSingle()
          pendingEmail = reload.data
        }
        if (!pendingEmail) {
          const failure = { lead_id, business_name: lead.business_name, reason: 'No pending Initial Email could be prepared' }
          failed.push(failure)
          outcomes.push({ ...failure, status: 'failed' })
          continue
        }
        const subject = pendingEmail.subject
        const bodyHtml = pendingEmail.body_html
        const bodyText = pendingEmail.body_text ?? ''

        const { data: sendTimeLead, error: sendTimeLeadErr } = await supabase
          .from('leads').select('email, delivery_suppressed_emails').eq('id', lead_id).maybeSingle()
        if (sendTimeLeadErr || !sendTimeLead?.email) {
          const skip = { lead_id, business_name: lead.business_name, reason: 'Current email address could not be verified' }
          skipped.push(skip)
          outcomes.push({ ...skip, status: 'skipped' })
          continue
        }
        if (isDeliverySuppressedForAddress(sendTimeLead.email, sendTimeLead.delivery_suppressed_emails)) {
          const skip = { lead_id, business_name: lead.business_name, reason: 'Current email has a terminal delivery failure' }
          skipped.push(skip)
          outcomes.push({ ...skip, status: 'skipped' })
          continue
        }

        const result = await sendEmail({ to: sendTimeLead.email, subject, html: bodyHtml, text: bodyText, leadId: lead_id })

        if (!result) {
          const failure = { lead_id, business_name: lead.business_name, reason: 'Email send failed' }
          failed.push(failure)
          outcomes.push({ ...failure, status: 'failed' })
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
          const failure = { lead_id, business_name: lead.business_name, reason: 'Email delivered but DB update failed — marked Sync Failed' }
          failed.push(failure)
          outcomes.push({ ...failure, status: 'failed' })
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
        outcomes.push({ lead_id, business_name: lead.business_name, status: 'succeeded' })
      } catch (err) {
        const failure = {
          lead_id,
          business_name: lead.business_name,
          reason: err instanceof Error ? err.message : 'Unknown error',
        }
        failed.push(failure)
        outcomes.push({ ...failure, status: 'failed' })
      } finally {
        await releaseLock(supabase, lockKey, lockToken)
      }
    }

    return NextResponse.json({
      sent,
      skipped: skipped.length,
      failed,
      skipped_items: skipped,
      outcomes,
      progress: summarizeLeadsBulkOutcomes(lead_ids.length, outcomes),
    })
  }

  // ── Delete ───────────────────────────────────────────────────────────────────
  if (action === 'delete') {
    let deleted = 0
    const failed: Array<{ lead_id: string; reason: string }> = []
    const outcomes: LeadsBulkOutcome[] = []

    for (const lead_id of lead_ids) {
      try {
        await supabase.from('follow_ups').delete().eq('lead_id', lead_id)
        await supabase.from('dm_queue').delete().eq('lead_id', lead_id)
        await supabase.from('deals').delete().eq('lead_id', lead_id)
        await supabase.from('activity_log').delete().eq('lead_id', lead_id)
        await supabase.from('emails').delete().eq('lead_id', lead_id)
        const { error } = await supabase.from('leads').delete().eq('id', lead_id)
        if (error) {
          const failure = { lead_id, reason: error.message }
          failed.push(failure)
          outcomes.push({ ...failure, status: 'failed' })
        } else {
          deleted++
          outcomes.push({ lead_id, status: 'succeeded' })
        }
      } catch (err) {
        const failure = { lead_id, reason: err instanceof Error ? err.message : 'Unknown error' }
        failed.push(failure)
        outcomes.push({ ...failure, status: 'failed' })
      }
    }

    return NextResponse.json({
      deleted,
      skipped: 0,
      failed,
      outcomes,
      progress: summarizeLeadsBulkOutcomes(lead_ids.length, outcomes),
    })
  }

  // ── Process Researched Leads to Email Ready ─────────────────────────────────
  if (action === 'process_researched_leads') {
    const outcomes: LeadsBulkOutcome[] = []
    const dedupeIndex = await fetchPipelineDedupeIndex(supabase)

    for (const lead_id of lead_ids) {
      const { data: lead } = await supabase
        .from('leads')
        .select('id, business_name, category_id, category_name, suburb, city, website, description, services, email, instagram_handle, content_type, status')
        .eq('id', lead_id)
        .single()

      if (!lead) {
        outcomes.push({ lead_id, business_name: lead_id, status: 'failed', reason: 'Lead not found' })
        continue
      }

      try {
        outcomes.push(await processResearchedLead(supabase, lead, dedupeIndex, initialEmailMode!))
      } catch (error) {
        outcomes.push({
          lead_id,
          business_name: lead.business_name,
          status: 'failed',
          reason: error instanceof Error ? error.message : 'Unknown error',
        })
      }
    }

    const progress = summarizeLeadsBulkOutcomes(lead_ids.length, outcomes)
    return NextResponse.json({
      processed: progress.succeeded,
      skipped: progress.skipped,
      failed: outcomes.filter((outcome) => outcome.status === 'failed'),
      mode: initialEmailMode,
      outcomes,
      progress,
    })
  }

  // ── Research Leads ───────────────────────────────────────────────────────────
  if (action === 'research_leads') {
    let researched = 0
    const failed: FailedItem[] = []
    const skipped: FailedItem[] = []
    const outcomes: LeadsBulkOutcome[] = []

    const dedupeIndex = await fetchPipelineDedupeIndex(supabase)

    for (const lead_id of lead_ids) {
      const { data: lead } = await supabase
        .from('leads')
        .select('*')
        .eq('id', lead_id)
        .single()

      if (!lead) {
        const failure = { lead_id, business_name: lead_id, reason: 'Lead not found' }
        failed.push(failure)
        outcomes.push({ ...failure, status: 'failed' })
        continue
      }
      if (lead.status !== 'new') {
        const skip = { lead_id, business_name: lead.business_name, reason: `Status is ${lead.status}, not new` }
        skipped.push(skip)
        outcomes.push({ ...skip, status: 'skipped' })
        continue
      }

      const researchResult = await researchOneLead(
        supabase,
        lead,
        researchPurposeForInitialEmailMode(initialEmailMode!),
      )
      if (!researchResult.success) {
        const failure = { lead_id, business_name: lead.business_name, reason: `Research failed: ${researchResult.error}` }
        failed.push(failure)
        outcomes.push({ ...failure, status: 'failed' })
        continue
      }

      // Merge enriched fields so writeOneLead sees the updated email/description/services/instagram
      const enrichedLead = { ...lead, ...researchResult.updatedFields }

      const writeResult = await writeOneLead(supabase, enrichedLead, dedupeIndex, initialEmailMode!)
      if (!writeResult.success) {
        const failure = { lead_id, business_name: lead.business_name, reason: `Draft generation failed: ${writeResult.error}` }
        failed.push(failure)
        outcomes.push({ ...failure, status: 'failed' })
        continue
      }
      if (writeResult.channel === 'dead') {
        const skip = { lead_id, business_name: lead.business_name, reason: 'No email found' }
        skipped.push(skip)
        outcomes.push({ ...skip, status: 'skipped' })
        continue
      }
      if (writeResult.channel === 'duplicate') {
        const skip = { lead_id, business_name: lead.business_name, reason: 'Duplicate email — skipped' }
        skipped.push(skip)
        outcomes.push({ ...skip, status: 'skipped' })
        continue
      }

      researched++
      outcomes.push({ lead_id, business_name: lead.business_name, status: 'succeeded' })
    }

    return NextResponse.json({
      researched,
      skipped: skipped.length,
      failed,
      skipped_items: skipped,
      mode: initialEmailMode,
      outcomes,
      progress: summarizeLeadsBulkOutcomes(lead_ids.length, outcomes),
    })
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
}
