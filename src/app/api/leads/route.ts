import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { checkRateLimit } from '@/lib/rateLimit'
import { STAGE_STATUSES, type LeadStage } from '@/lib/lead-status'
import { normalizeEmail, extractRootDomainFromEmail, PERSONAL_EMAIL_PROVIDER_DOMAINS } from '@/lib/deduplication'

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

  const { business_name, email, website, suburb, city, category_id, category_name, force } = parsed.data

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
    })
    .select()
    .single()

  if (leadErr || !lead) {
    return NextResponse.json({ error: leadErr?.message ?? 'Insert failed' }, { status: 500 })
  }

  return NextResponse.json({ data: lead }, { status: 201 })
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
