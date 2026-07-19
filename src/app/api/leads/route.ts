import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { checkRateLimit } from '@/lib/rateLimit'
import { STAGE_STATUSES, type LeadStage } from '@/lib/lead-status'
import { normalizeEmail, extractRootDomainFromEmail, PERSONAL_EMAIL_PROVIDER_DOMAINS } from '@/lib/deduplication'
import { resolveContentType } from '@/lib/content-type'
import { writeOutreachEmail } from '@/lib/claude'
import { emailBodyToHtml } from '@/lib/utils'
import { generateFollowUpEmail, type FollowUpThreadEmail } from '@/lib/followup-generation'
import {
  STAGE_VALUES,
  STAGE_LABELS,
  FOLLOW_UP_NUMBER,
  computeBackdatedStageEmails,
  type LeadImportStage,
} from '@/lib/stage-import'
import type { FollowUpType } from '@/lib/followup-eligibility'

const patchLeadSchema = z.object({
  id: z.string().uuid(),
}).catchall(z.unknown())

const createLeadSchema = z.object({
  business_name: z.string().min(1),
  email: z.string().email(),
  website: z.string().optional(),
  suburb: z.string().min(1),
  city: z.string().min(1),
  category_id: z.string().uuid(),
  category_name: z.string().min(1),
  force: z.boolean().optional(),
  current_stage: z.enum(STAGE_VALUES).default('new'),
  stage_completed_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
}).superRefine((data, ctx) => {
  if (data.current_stage === 'new') return

  if (!data.stage_completed_date) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['stage_completed_date'],
      message: 'Stage Completed Date is required when Current Stage is not "New (No Email Sent)"',
    })
    return
  }

  const completedDate = new Date(`${data.stage_completed_date}T00:00:00.000Z`)
  if (Number.isNaN(completedDate.getTime())) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['stage_completed_date'], message: 'Invalid date' })
    return
  }

  const today = new Date()
  const todayUtc = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()))
  if (completedDate.getTime() > todayUtc.getTime()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['stage_completed_date'], message: 'Stage Completed Date cannot be in the future' })
  }
})

export async function POST(request: NextRequest): Promise<NextResponse> {
  const ip = request.headers.get('x-forwarded-for') ?? request.headers.get('x-real-ip') ?? 'global'
  const { allowed } = checkRateLimit(`leads:${ip}`, 60)
  if (!allowed) return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 })

  const supabase = await createClient()
  const raw = await request.json()

  const parsed = createLeadSchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request body', issues: parsed.error.issues }, { status: 400 })
  }

  const {
    business_name, email, website, suburb, city, category_id, category_name, force,
    current_stage, stage_completed_date,
  } = parsed.data

  // Exact email duplicate check
  const normalizedEmail = normalizeEmail(email)!
  const { data: emailDupe } = await supabase
    .from('leads')
    .select('id, business_name')
    .ilike('email', normalizedEmail)
    .limit(1)
    .maybeSingle()

  if (emailDupe) {
    return NextResponse.json({
      error: 'Lead already exists',
      type: 'email_duplicate',
      existing: { id: emailDupe.id, business_name: emailDupe.business_name },
    }, { status: 409 })
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
        return NextResponse.json({
          error: `A lead already exists for ${rootDomain}`,
          type: 'domain_duplicate',
          domain: rootDomain,
          existing: { id: domainDupe.id, business_name: domainDupe.business_name },
        }, { status: 409 })
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
      email,
      website:       website ?? null,
      suburb,
      city,
      category_id,
      category_name,
      status:        'researched',
      source:        'manual',
      content_type:  resolveContentType(category, city),
    })
    .select()
    .single()

  if (leadErr || !lead) {
    return NextResponse.json({ error: leadErr?.message ?? 'Insert failed' }, { status: 500 })
  }

  // Staged import: the lead has already progressed past "new" outside this
  // system. Backfill every stage up to and including `current_stage` as
  // already-sent emails, backdated so the existing follow-up engine picks up
  // the sequence from the next stage using its normal intervals.
  if (current_stage !== 'new' && stage_completed_date) {
    const backfillResult = await backfillLeadStageHistory(supabase, {
      leadId:       lead.id,
      businessName: business_name,
      website,
      suburb,
      city,
      categoryName: category_name,
      contentType:  (lead.content_type as string | null) ?? 'remote',
      stage:        current_stage,
      completedDate: new Date(`${stage_completed_date}T00:00:00.000Z`),
    })

    if (!backfillResult.ok) {
      // Roll back the lead so we never leave a lead stuck without its stage history.
      await supabase.from('leads').delete().eq('id', lead.id)
      return NextResponse.json({ error: backfillResult.error }, { status: 500 })
    }

    return NextResponse.json({ data: backfillResult.lead }, { status: 201 })
  }

  return NextResponse.json({ data: lead }, { status: 201 })
}

async function backfillLeadStageHistory(
  supabase: Awaited<ReturnType<typeof createClient>>,
  params: {
    leadId: string
    businessName: string
    website?: string
    suburb: string
    city: string
    categoryName: string
    contentType: string
    stage: LeadImportStage
    completedDate: Date
  }
): Promise<{ ok: true; lead: unknown } | { ok: false; error: string }> {
  const { leadId, businessName, website, suburb, city, categoryName, contentType, stage, completedDate } = params

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
    suburb,
    city,
    website:       website ?? '',
    description:   '',
    services:      '',
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
        suburb,
        city,
        website:      website ?? '',
        description:  '',
        services:     '',
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

export async function GET(request: NextRequest): Promise<NextResponse> {
  const ip = request.headers.get('x-forwarded-for') ?? request.headers.get('x-real-ip') ?? 'global'
  const { allowed } = checkRateLimit(`leads:${ip}`, 60)
  if (!allowed) return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 })

  const supabase = await createClient()
  const { searchParams } = new URL(request.url)

  const status = searchParams.get('status')
  const stage = searchParams.get('stage') as LeadStage | null
  const category = searchParams.get('category')
  const city = searchParams.get('city')
  const search = searchParams.get('search')
  const page = parseInt(searchParams.get('page') ?? '1', 10)
  const limit = 50
  const offset = (page - 1) * limit

  let query = supabase.from('leads').select('*', { count: 'exact' })

  // `stage` expands to all canonical statuses for that stage (e.g. negotiating → negotiating+interested)
  // `status` is an exact single-status match (backward compat)
  if (stage && STAGE_STATUSES[stage]) {
    query = query.in('status', STAGE_STATUSES[stage] as string[])
  } else if (status) {
    query = query.eq('status', status)
  }
  if (category) query = query.eq('category_name', category)
  if (city) query = query.eq('city', city)
  if (search) query = query.ilike('business_name', `%${search}%`)

  query = query.order('created_at', { ascending: false }).range(offset, offset + limit - 1)

  const { data, error, count } = await query

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ data, count, page, limit })
}

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  const ip = request.headers.get('x-forwarded-for') ?? request.headers.get('x-real-ip') ?? 'global'
  const { allowed } = checkRateLimit(`leads:${ip}`, 60)
  if (!allowed) return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 })

  const supabase = await createClient()
  const raw = await request.json()

  const parsed = patchLeadSchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request body', issues: parsed.error.issues }, { status: 400 })
  }

  const { id, ...updates } = parsed.data

  const { data, error } = await supabase
    .from('leads')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  if (updates.status === 'closed_manual') {
    await supabase.from('dm_queue').update({ status: 'skipped' }).eq('lead_id', id).eq('status', 'pending')
    await supabase.from('follow_ups').update({ status: 'cancelled' }).eq('lead_id', id).eq('status', 'scheduled')
  }

  return NextResponse.json({ data })
}
