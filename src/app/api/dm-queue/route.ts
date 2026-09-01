import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolvePagination } from '@/lib/pagination'
import { normalizeSearchTerm } from '@/lib/search'

export async function GET(request: NextRequest): Promise<NextResponse> {
  const supabase = await createClient()
  const { searchParams } = new URL(request.url)

  const status = searchParams.get('status')
  const platform = searchParams.get('platform')
  const city = searchParams.get('city')
  const pagination = resolvePagination({
    page: searchParams.get('page'),
    pageSize: searchParams.get('page_size'),
  })
  const { data: result, error } = await supabase.rpc('get_dm_queue_search_page', {
    p_status: status,
    p_platform: platform,
    p_city: city,
    p_search: normalizeSearchTerm(searchParams.get('search')),
    p_page: pagination.page,
    p_page_size: pagination.pageSize,
  })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const report = result && typeof result === 'object' ? result as { data?: unknown; total?: unknown } : {}
  return NextResponse.json({
    data: Array.isArray(report.data) ? report.data : [],
    total: Number(report.total ?? 0) || 0,
    page: pagination.page,
    page_size: pagination.pageSize,
  })
}

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  const supabase = await createClient()
  const body = await request.json() as { id: string; status: 'sent' | 'skipped' | 'pending' }

  const update: Record<string, unknown> = { status: body.status }
  if (body.status === 'sent') {
    update.sent_at = new Date().toISOString()
  }

  const { data, error } = await supabase
    .from('dm_queue')
    .update(update)
    .eq('id', body.id)
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ data })
}
