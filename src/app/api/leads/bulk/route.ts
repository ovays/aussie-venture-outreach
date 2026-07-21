import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createServiceClient } from '@/lib/supabase/server'
import { sendEmail } from '@/lib/resend'
import { fetchPipelineDedupeIndex } from '@/lib/deduplication'
import { researchOneLead } from '@/lib/research-lead'
import { writeOneLead, type DmState } from '@/lib/write-lead'
import { handleEmailSyncFailure } from '@/lib/email-status'
import { acquireLock, releaseLock } from '@/lib/distributed-lock'
import { logger } from '@/lib/logger'

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

        const result = await sendEmail({ to: lead.email, subject, html: bodyHtml, text: bodyText, leadId: lead_id })

        if (!result) {
          failed.push({ lead_id, business_name: lead.business_name, reason: 'Email send failed' })
          continue
        }

        const sentAt = new Date().toISOString()

        if (pendingEmail?.id) {
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
        } else {
          const { error: insertErr } = await supabase.from('emails').insert({
            lead_id, type: 'initial_pitch', subject, body_html: bodyHtml, body_text: bodyText,
            status: 'sent', resend_id: result.id, message_id: result.messageId, sent_at: sentAt,
          })
          if (insertErr) {
            // No pre-existing row — insert a recovery row directly.
            const { error: recoveryErr } = await supabase.from('emails').insert({
              lead_id, type: 'initial_pitch', subject, body_html: bodyHtml, body_text: bodyText,
              status: 'email_sync_failed', resend_id: result.id, message_id: result.messageId, sent_at: sentAt,
            })
            if (recoveryErr) {
              logger.error('bulk-send', 'Recovery row insert also failed — delivered email has no DB record', {
                lead_id, error: recoveryErr.message, resend_id: result.id,
              })
            }
            await supabase.from('leads').update({ status: 'contacted', updated_at: sentAt }).eq('id', lead_id)
            failed.push({ lead_id, business_name: lead.business_name, reason: `Email delivered but DB insert failed — marked Sync Failed` })
            continue
          }
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

    // Initialise DM state — needed if any selected leads have no email
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
    const dmState: DmState = { dmsAddedToday: todayDmCount ?? 0, dailyDmLimit }

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

      const researchResult = await researchOneLead(supabase, lead)
      if (!researchResult.success) {
        failed.push({ lead_id, business_name: lead.business_name, reason: `Research failed: ${researchResult.error}` })
        continue
      }

      // Merge enriched fields so writeOneLead sees the updated email/description/services/instagram
      const enrichedLead = { ...lead, ...researchResult.updatedFields }

      const writeResult = await writeOneLead(supabase, enrichedLead, dedupeIndex, dmState)
      if (!writeResult.success) {
        failed.push({ lead_id, business_name: lead.business_name, reason: `Draft generation failed: ${writeResult.error}` })
        continue
      }
      if (writeResult.channel === 'dead') {
        failed.push({ lead_id, business_name: lead.business_name, reason: 'No email or Instagram found' })
        continue
      }
      if (writeResult.channel === 'duplicate') {
        failed.push({ lead_id, business_name: lead.business_name, reason: 'Duplicate email — skipped' })
        continue
      }

      researched++
    }

    return NextResponse.json({ researched, failed })
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
}
