// Single source of truth for inserting a lead — used by the manual Add Lead
// form (src/app/api/leads/route.ts POST) and the CSV bulk import endpoint
// (src/app/api/leads/import/route.ts) so every lead-creation path shares the
// exact same dedupe checks, staged-import backfill, and insert shape.

import type { SupabaseClient } from '@supabase/supabase-js'
import { normalizeEmail, extractRootDomainFromEmail, PERSONAL_EMAIL_PROVIDER_DOMAINS } from '@/lib/deduplication'
import { resolveContentType } from '@/lib/content-type'
import { emailBodyToHtml } from '@/lib/utils'
import { generateFollowUpEmail, type FollowUpThreadEmail } from '@/lib/followup-generation'
import { logger } from '@/lib/logger'
import {
  STAGE_LABELS,
  FOLLOW_UP_NUMBER,
  computeBackdatedStageEmails,
  type LeadImportStage,
} from '@/lib/stage-import'
import type { FollowUpType } from '@/lib/followup-eligibility'
import { routeInitialEmail } from '@/lib/initial-email-router'
import type { InitialEmailMode } from '@/lib/settingsDefaults'
import { saveInitialEmailModeSnapshot } from '@/lib/initial-email-mode-snapshot'
import { claimRecipientOutreach, classifyEmailQuality } from '@/lib/data-quality'

export type InitialEmailCreationPolicy =
  | { mode: InitialEmailMode; action: 'generate_now' }
  | { mode: InitialEmailMode; action: 'defer_to_writer'; snapshotSource: 'csv_import' }

export interface CreateLeadInput {
  business_name: string
  email: string
  website?: string
  suburb?: string
  city: string
  category_id: string
  category_name: string
  force?: boolean
  current_stage: LeadImportStage
  stage_completed_date?: string
  source?: string
  initialEmail?: InitialEmailCreationPolicy
}

export type CreateLeadResult =
  | { ok: true; status: 201; lead: Record<string, unknown>; generationError?: string }
  | {
      ok: false
      status: 409
      type: 'email_duplicate' | 'domain_duplicate'
      error: string
      domain?: string
      existing: { id: string; business_name: string }
    }
  | { ok: false; status: 400 | 500; error: string }

export async function createLead(supabase: SupabaseClient, input: CreateLeadInput): Promise<CreateLeadResult> {
  const {
    business_name, email, website, suburb, city, category_id, category_name, force,
    current_stage, stage_completed_date, source, initialEmail,
  } = input

  const normalizedEmail = normalizeEmail(email)
  const emailQuality = classifyEmailQuality(email)
  if (!normalizedEmail || emailQuality.issueType === 'invalid_email') {
    return { ok: false, status: 400, error: 'Invalid email address' }
  }

  // Exact email duplicate check
  const { data: emailDupe } = await supabase
    .from('leads')
    .select('id, business_name')
    .ilike('email', normalizedEmail)
    .limit(1)
    .maybeSingle()

  // Root domain duplicate check (warning — skipped if force = true)
  // Do not reject an exact recipient match. Different businesses can share an
  // agency or booking inbox; recipient ownership prevents competing outreach.
  if (!force && !emailDupe) {
    const rootDomain = extractRootDomainFromEmail(email)
    if (rootDomain && !PERSONAL_EMAIL_PROVIDER_DOMAINS.has(rootDomain)) {
      const { data: domainDupe } = await supabase
        .from('leads')
        .select('id, business_name')
        .or(`email.ilike.%@${rootDomain},email.ilike.%.${rootDomain}`)
        .limit(1)
        .maybeSingle()

      if (domainDupe) {
        return {
          ok: false,
          status: 409,
          type: 'domain_duplicate',
          error: `A lead already exists for ${rootDomain}`,
          domain: rootDomain,
          existing: { id: domainDupe.id, business_name: domainDupe.business_name },
        }
      }
    }
  }

  const { data: category } = await supabase
    .from('categories')
    .select('name, content_type, city_content_types')
    .eq('id', category_id)
    .maybeSingle()

  const { data: lead, error: leadErr } = await supabase
    .from('leads')
    .insert({
      business_name,
      email: normalizedEmail,
      website:       website || null,
      suburb:        suburb || null,
      city,
      category_id,
      category_name,
      status:        'researched',
      source:        source ?? 'manual',
      content_type:  resolveContentType(category, city),
      description:   null,
      services:      null,
      instagram_handle: null,
      facebook_url:  null,
    })
    .select()
    .single()

  if (leadErr || !lead) {
    return { ok: false, status: 500, error: leadErr?.message ?? 'Insert failed' }
  }

  // Keep junk addresses for audit/cleanup, but never prepare them for email
  // outreach. The database trigger attached the deterministic quality flag.
  if (emailQuality.issueType === 'placeholder_email' || emailQuality.issueType === 'technical_email') {
    return { ok: true, status: 201, lead: lead as Record<string, unknown> }
  }

  if (current_stage !== 'new' && stage_completed_date) {
    const ownership = await claimRecipientOutreach(supabase, lead.id, 'initial')
    if (!ownership.allowed) {
      return {
        ok: true,
        status: 201,
        lead: lead as Record<string, unknown>,
        generationError: ownership.reason === 'email_already_contacted'
          ? 'Stage history not imported because this email already has an outreach owner.'
          : `Stage history not imported: ${ownership.reason ?? 'recipient suppressed'}.`,
      }
    }
  }

  // Staged import: the lead has already progressed past "new" outside this
  // system. Backfill every stage up to and including `current_stage` as
  // already-sent emails, backdated so the existing follow-up engine picks up
  // the sequence from the next stage using its normal intervals.
  if (current_stage !== 'new' && stage_completed_date) {
    // AI generation (writeOutreachEmail / generateFollowUpEmail) can throw —
    // network error, API error, malformed response — not just return a
    // Supabase-style { error }. Catch here too, not only the explicit
    // ok:false path below, so no exception can leave the lead we just
    // inserted above stranded without its backfilled stage history.
    try {
      const backfillResult = await backfillLeadStageHistory(supabase, {
        leadId:       lead.id,
        businessName: business_name,
        website,
        suburb,
        city,
        categoryName: category_name,
        categoryId: category_id,
        contentType:  (lead.content_type as string | null) ?? 'remote',
        stage:        current_stage,
        completedDate: new Date(`${stage_completed_date}T00:00:00.000Z`),
        initialEmailMode: initialEmail?.mode ?? 'ai_personalised',
      })

      if (!backfillResult.ok) {
        await rollbackStagedLead(supabase, lead.id, backfillResult.error)
        return { ok: false, status: 500, error: backfillResult.error }
      }

      return { ok: true, status: 201, lead: backfillResult.lead as Record<string, unknown> }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unexpected error during staged import'
      await rollbackStagedLead(supabase, lead.id, message)
      return { ok: false, status: 500, error: `Failed to backfill stage history: ${message}` }
    }
  }

  if (!initialEmail) {
    return { ok: true, status: 201, lead: lead as Record<string, unknown> }
  }

  if (initialEmail.action === 'defer_to_writer') {
    const snapshot = await saveInitialEmailModeSnapshot(supabase, lead.id, initialEmail.mode, initialEmail.snapshotSource)
    if (!snapshot.ok) {
      await rollbackStagedLead(supabase, lead.id, snapshot.error)
      return { ok: false, status: 500, error: `Failed to stage Initial Email generation: ${snapshot.error}` }
    }
    return { ok: true, status: 201, lead: lead as Record<string, unknown> }
  }

  const generated = await routeInitialEmail(supabase, {
    id: lead.id, business_name, category_id, category_name, suburb: suburb ?? null, city,
    website: website ?? null, description: null, services: null, content_type: (lead.content_type as string | null) ?? 'remote',
  }, initialEmail.mode)
  return generated.ok
    ? { ok: true, status: 201, lead: lead as Record<string, unknown> }
    : { ok: true, status: 201, lead: lead as Record<string, unknown>, generationError: `${generated.error.code}: ${generated.error.reason}` }
}

// Deletes the lead created just before the staged-import backfill so a
// failure partway through (AI generation, email insert, follow_ups insert,
// status update) never leaves an orphaned lead with no stage history. Emails,
// follow_ups, and deals for this lead all cascade-delete via ON DELETE
// CASCADE (migration 001) — deleting the lead row is sufficient to remove
// everything the failed attempt may have partially created.
async function rollbackStagedLead(
  supabase: SupabaseClient,
  leadId: string,
  reason: string
): Promise<void> {
  const { error } = await supabase.from('leads').delete().eq('id', leadId)
  if (error) {
    // Nothing more we can do from the request path — log enough to find and
    // clean up the orphaned lead manually.
    logger.error('leads-api', 'Failed to roll back staged-import lead after failure', {
      lead_id: leadId,
      reason,
      rollback_error: error.message,
    })
  }
}

async function backfillLeadStageHistory(
  supabase: SupabaseClient,
  params: {
    leadId: string
    businessName: string
    website?: string
    suburb?: string
    city: string
    categoryName: string
    categoryId: string
    contentType: string
    stage: LeadImportStage
    completedDate: Date
    initialEmailMode: InitialEmailMode
  }
): Promise<{ ok: true; lead: unknown } | { ok: false; error: string }> {
  const { leadId, businessName, website, suburb, city, categoryName, categoryId, contentType, stage, completedDate, initialEmailMode } = params

  const { data: settingsRows } = await supabase
    .from('settings')
    .select('key, value')
    .in('key', ['follow_up_1_days', 'follow_up_2_days', 'follow_up_3_days'])

  const sm: Record<string, string> = {}
  for (const row of settingsRows ?? []) sm[row.key] = row.value

  const followUpSettings = {
    fu1Days: parseInt(sm['follow_up_1_days'] ?? '7', 10),
    fu2Days: parseInt(sm['follow_up_2_days'] ?? '14', 10),
    fu3Days: parseInt(sm['follow_up_3_days'] ?? '21', 10),
  }

  const stageEmails = computeBackdatedStageEmails(stage, completedDate, followUpSettings)

  const generatedInitial = await routeInitialEmail(supabase, {
    id: leadId, business_name: businessName, category_id: categoryId, category_name: categoryName,
    suburb: suburb ?? null, city, website: website ?? null, description: null, services: null, content_type: contentType,
  }, initialEmailMode, { operation: 'content_only' })
  if (!generatedInitial.ok) return { ok: false, error: `${generatedInitial.error.code}: ${generatedInitial.error.reason}` }
  const emailResult = { subject: generatedInitial.subject!, body: generatedInitial.body! }

  // Built sequentially (not .map()) because each follow-up's AI prompt needs
  // the full thread up to that point, including any earlier follow-ups
  // backfilled in this same import — the exact same generateFollowUpEmail()
  // path the live daily sender uses, so imported and organic leads never
  // diverge in how their follow-up content is produced.
  const emailRows: Array<{
    lead_id: string
    type: string
    subject: string
    body_html: string
    body_text: string
    status: string
      sent_at: string
      generation_source?: 'ai' | 'template'
  }> = []
  const history: FollowUpThreadEmail[] = [{ type: 'initial_pitch', subject: emailResult.subject, body: emailResult.body }]

  for (const stageEmail of stageEmails) {
    if (stageEmail.type === 'initial_pitch') {
      emailRows.push({
        lead_id:   leadId,
        type:      'initial_pitch',
        subject:   emailResult.subject,
        body_html: emailBodyToHtml(emailResult.body),
        body_text: emailResult.body,
        status:    'sent',
        sent_at:   stageEmail.sentAt.toISOString(),
        generation_source: generatedInitial.generationSource,
      })
      continue
    }

    const generated = await generateFollowUpEmail(
      stageEmail.type,
      {
        businessName: businessName,
        category:     categoryName,
        suburb:       suburb ?? '',
        city,
        website:      website ?? '',
        description:  '',
        services:     '',
        notes:        '',
        contentType,
      },
      emailResult.subject,
      history,
      undefined,
      { supabase, categoryId },
    )

    emailRows.push({
      lead_id:   leadId,
      type:      stageEmail.type,
      subject:   generated.subject,
      body_html: generated.html,
      body_text: generated.body,
      status:    'sent',
      sent_at:   stageEmail.sentAt.toISOString(),
    })
    history.push({ type: stageEmail.type, subject: generated.subject, body: generated.body })
  }

  const { data: insertedEmails, error: emailInsertErr } = await supabase
    .from('emails')
    .insert(emailRows)
    .select('id, type')

  if (emailInsertErr) {
    return { ok: false, error: `Failed to backfill stage history: ${emailInsertErr.message}` }
  }

  const followUpAuditRows = (insertedEmails ?? [])
    .filter((e): e is { id: string; type: FollowUpType } => e.type !== 'initial_pitch')
    .map((e) => {
      const stageEmail = stageEmails.find((se) => se.type === e.type)!
      return {
        lead_id:          leadId,
        follow_up_number: FOLLOW_UP_NUMBER[e.type],
        scheduled_at:     stageEmail.sentAt.toISOString(),
        sent_at:          stageEmail.sentAt.toISOString(),
        email_id:         e.id,
        status:           'sent',
      }
    })

  if (followUpAuditRows.length > 0) {
    await supabase.from('follow_ups').insert(followUpAuditRows)
  }

  const nowIso = new Date().toISOString()

  const { data: updatedLead, error: updateErr } = await supabase
    .from('leads')
    .update({ status: 'contacted', updated_at: nowIso })
    .eq('id', leadId)
    .select()
    .single()

  if (updateErr || !updatedLead) {
    return { ok: false, error: updateErr?.message ?? 'Failed to update lead status after backfill' }
  }

  await supabase.from('activity_log').insert({
    event_type:  'lead_imported_at_stage',
    lead_id:     leadId,
    description: `Lead imported with "${STAGE_LABELS[stage]}" marked completed on ${completedDate.toISOString().slice(0, 10)}`,
    metadata:    { stage, stage_completed_date: completedDate.toISOString().slice(0, 10) },
  })

  return { ok: true, lead: updatedLead }
}
