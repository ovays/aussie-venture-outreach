import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { checkRateLimit } from '@/lib/rateLimit'
import { STAGE_STATUSES, type LeadStage } from '@/lib/lead-status'
import { STAGE_VALUES } from '@/lib/stage-import'
import { createLead } from '@/lib/create-lead'
import { readInitialEmailMode } from '@/lib/initial-email-router'
import { resolvePagination } from '@/lib/pagination'
import { normalizeSearchTerm } from '@/lib/search'
import {
  FILTERED_IDS_PAGE_SIZE,
  LEADS_MAX_PAGE_SIZE,
  LEADS_PAGE_SIZE,
} from '@/lib/leads-list'

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
  const initialEmailMode = await readInitialEmailMode(supabase)
  const raw = await request.json()

  const parsed = createLeadSchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request body', issues: parsed.error.issues }, { status: 400 })
  }

  const {
    business_name, email, website, suburb, city, category_id, category_name, force,
    current_stage, stage_completed_date,
  } = parsed.data

  const result = await createLead(supabase, {
    business_name, email, website, suburb, city, category_id, category_name, force,
    current_stage, stage_completed_date,
    initialEmail: { mode: initialEmailMode, action: 'generate_now' },
  })

  if (!result.ok) {
    if (result.status === 409) {
      return NextResponse.json({
        error: result.error,
        type: result.type,
        ...(result.domain && { domain: result.domain }),
        existing: result.existing,
      }, { status: 409 })
    }
    return NextResponse.json({ error: result.error }, { status: result.status })
  }

  return NextResponse.json({ data: result.lead, generation_error: result.generationError ?? null, mode: initialEmailMode }, { status: 201 })
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
  const search = normalizeSearchTerm(searchParams.get('search'))
  const idsOnly = searchParams.get('ids_only') === 'true'
  const pagination = resolvePagination(
    {
      page: searchParams.get('page'),
      pageSize: searchParams.get('page_size'),
    },
    idsOnly
      ? { defaultPageSize: FILTERED_IDS_PAGE_SIZE, maxPageSize: FILTERED_IDS_PAGE_SIZE }
      : { defaultPageSize: LEADS_PAGE_SIZE, maxPageSize: LEADS_MAX_PAGE_SIZE },
  )
  let statuses: string[] | null = null
  if (stage && STAGE_STATUSES[stage]) {
    statuses = [...STAGE_STATUSES[stage]]
  } else if (status) {
    statuses = [status]
  }

  const { data: result, error } = await supabase.rpc('get_leads_search_page', {
    p_statuses: statuses,
    p_category: category,
    p_city: city,
    p_search: search,
    p_page: pagination.page,
    p_page_size: pagination.pageSize,
    p_ids_only: idsOnly,
  })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const report = result && typeof result === 'object' ? result as { data?: unknown; total?: unknown } : {}
  return NextResponse.json({
    data: Array.isArray(report.data) ? report.data : [],
    count: Number(report.total ?? 0) || 0,
    page: pagination.page,
    limit: pagination.pageSize,
  })
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
