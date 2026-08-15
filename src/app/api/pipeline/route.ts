import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolvePagination, toSupabaseRange } from '@/lib/pagination'
import { STAGE_STATUSES, type LeadStage } from '@/lib/lead-status'

const PIPELINE_FIELDS = 'id, business_name, category_name, city, suburb, status, deal_value, created_at'
const NEW_STATUSES = ['new'] as const

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = request.nextUrl
  const stage = searchParams.get('stage') ?? 'new'
  const statuses = stage === 'new'
    ? NEW_STATUSES
    : STAGE_STATUSES[stage as LeadStage]

  if (!statuses) {
    return NextResponse.json({ error: 'Invalid pipeline stage' }, { status: 400 })
  }

  const pagination = resolvePagination({
    page: searchParams.get('page'),
    pageSize: searchParams.get('page_size'),
  })
  const { from, to } = toSupabaseRange(pagination)
  const supabase = await createClient()
  let query = supabase
    .from('leads')
    .select(PIPELINE_FIELDS, { count: 'exact' })
    .in('status', [...statuses])

  const search = (searchParams.get('search') ?? '').trim()
  if (search) query = query.ilike('business_name', `%${search}%`)

  const { data, error, count } = await query
    .order('created_at', { ascending: false })
    .order('id', { ascending: true })
    .range(from, to)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({
    data: data ?? [],
    total: count ?? 0,
    page: pagination.page,
    page_size: pagination.pageSize,
  })
}
