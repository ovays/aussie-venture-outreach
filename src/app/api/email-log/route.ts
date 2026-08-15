import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolvePagination, toSupabaseRange } from '@/lib/pagination'

const EMAIL_LIST_FIELDS = 'id, type, subject, status, sent_at, replied_at, created_at, leads(business_name, category_name, city)'

export async function GET(request: NextRequest): Promise<NextResponse> {
  const supabase = await createClient()
  const { searchParams } = request.nextUrl
  const type = searchParams.get('type') || null
  const status = searchParams.get('status') || null
  const search = (searchParams.get('search') ?? '').trim()
  const pagination = resolvePagination({ page: searchParams.get('page'), pageSize: searchParams.get('page_size') })
  const { from, to } = toSupabaseRange(pagination)

  let query = supabase.from('emails').select(EMAIL_LIST_FIELDS, { count: 'exact' })
  if (type) query = query.eq('type', type)
  if (status) query = query.eq('status', status)
  if (search) query = query.ilike('subject', `%${search}%`)

  const [listResult, summaryResult] = await Promise.all([
    query.order('created_at', { ascending: false }).order('id', { ascending: true }).range(from, to),
    supabase.rpc('get_email_log_summary', { p_type: type, p_status: status, p_search: search }),
  ])

  if (listResult.error) return NextResponse.json({ error: listResult.error.message }, { status: 500 })
  if (summaryResult.error) return NextResponse.json({ error: summaryResult.error.message }, { status: 500 })

  return NextResponse.json({
    data: listResult.data ?? [],
    total: listResult.count ?? 0,
    page: pagination.page,
    page_size: pagination.pageSize,
    summary: summaryResult.data,
  })
}
