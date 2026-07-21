// Single source of truth for inserting a lead — used by the manual Add Lead
// form (src/app/api/leads/route.ts POST) and the CSV bulk import endpoint
// (src/app/api/leads/import/route.ts) so every lead-creation path shares the
// exact same dedupe checks, staged-import backfill, and insert shape.

import type { SupabaseClient } from '@supabase/supabase-js'
import { normalizeEmail, extractRootDomainFromEmail, PERSONAL_EMAIL_PROVIDER_DOMAINS } from '@/lib/deduplication'
import { resolveContentType } from '@/lib/content-type'
import { writeOutreachEmail, extractWebsiteData } from '@/lib/claude'
import { fetchRawHtml } from '@/lib/email-extraction'
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
}

export type CreateLeadResult =
  | { ok: true; status: 201; lead: Record<string, unknown> }
  | {
      ok: false
      status: 409
      type: 'email_duplicate' | 'domain_duplicate'
      error: string
      domain?: string
      existing: { id: string; business_name: string }
    }
  | { ok: false; status: 400 | 500; error: string }

// Same fetch + strip + extractWebsiteData() pipeline research-lead.ts uses for
// the pipeline's researcher agent, run inline at creation time so manually
// added and bulk-imported leads get the same real website-derived
// description/services instead of the writer prompts seeing blank fields.
// Never throws — a fetch/extraction failure just falls back to blanks so one
// bad website can't fail the lead creation (or, in bulk import, the row).
export async function enrichFromWebsite(
  website: string | undefined,
  businessName: string
): Promise<{
  description: string
  services: string
  instagram_handle: string | null
  facebook_url: string | null
}> {
  const empty = { description: '', services: '', instagram_handle: null, facebook_url: null }
  if (!website) return empty

  try {
    const rawHtml = await fetchRawHtml(website)
    const websiteText = rawHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 5000)
    if (!websiteText) return empty

    const enriched = await extractWebsiteData(websiteText)
    return {
      description: enriched.description || '',
      services: enriched.services || '',
      instagram_handle: enriched.instagram_handle || null,
      facebook_url: enriched.facebook_url || null,
    }
  } catch (enrichErr) {
    logger.info('create-lead', `Website enrichment failed for "${businessName}" — continuing without it`, {
      website,
      error: enrichErr instanceof Error ? enrichErr.message : String(enrichErr),
    })
    return empty
  }
}

export async function createLead(supabase: SupabaseClient, input: CreateLeadInput): Promise<CreateLeadResult> {
  const {
    business_name, email, website, suburb, city, category_id, category_name, force,
    current_stage, stage_completed_date, source,
  } = input

  const normalizedEmail = normalizeEmail(email)
  if (!normalizedEmail) {
    return { ok: false, status: 400, error: 'Invalid email address' }
  }

  // Exact email duplicate check
  const { data: emailDupe } = await supabase
    .from('leads')
    .select('id, business_name')
    .ilike('email', normalizedEmail)
    .limit(1)
    .maybeSingle()

  if (emailDupe) {
    return {
      ok: false,
      status: 409,
      type: 'email_duplicate',
      error: 'Lead already exists',
      existing: { id: emailDupe.id, business_name: emailDupe.business_name },
    }
  }

  // Root domain duplicate check (warning — skipped if force = true)
  if (!force) {
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

  const enrichment = await enrichFromWebsite(website, business_name)

  const { data: lead, error: leadErr } = await supabase
    .from('leads')
    .insert({
      business_name,
      email,
      website:       website || null,
      suburb:        suburb || null,
      city,
      category_id,
      category_name,
      status:        'researched',
      source:        source ?? 'manual',
      content_type:  resolveContentType(category, city),
      description:   enrichment.description || null,
      services:      enrichment.services || null,
      instagram_handle: enrichment.instagram_handle,
      facebook_url:  enrichment.facebook_url,
    })
    .select()
    .single()

  if (leadErr || !lead) {
    return { ok: false, status: 500, error: leadErr?.message ?? 'Insert failed' }
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
        contentType:  (lead.content_type as string | null) ?? 'remote',
        description:  enrichment.description,
        services:     enrichment.services,
        stage:        current_stage,
        completedDate: new Date(`${stage_completed_date}T00:00:00.000Z`),
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

  return { ok: true, status: 201, lead: lead as Record<string, unknown> }
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
    contentType: string
    description: string
    services: string
    stage: LeadImportStage
    completedDate: Date
  }
): Promise<{ ok: true; lead: unknown } | { ok: false; error: string }> {
  const { leadId, businessName, website, suburb, city, categoryName, contentType, description, services, stage, completedDate } = params

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

  const emailResult = await writeOutreachEmail({
    business_name: businessName,
    category:      categoryName,
    suburb:        suburb ?? '',
    city,
    website:       website ?? '',
    description,
    services,
    content_type:  contentType,
  })

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
        description,
        services,
        notes:        '',
        contentType,
      },
      emailResult.subject,
      history
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
