import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolvePagination } from '@/lib/pagination'
import { normalizeSearchTerm } from '@/lib/search'

export async function GET(request: NextRequest): Promise<NextResponse> {
  const supabase = await createClient()
  const { searchParams } = request.nextUrl
  const type = searchParams.get('type') || null
  const status = searchParams.get('status') || null
  const search = normalizeSearchTerm(searchParams.get('search'))
  const pagination = resolvePagination({ page: searchParams.get('page'), pageSize: searchParams.get('page_size') })

  const [listResult, summaryResult] = await Promise.all([
    supabase.rpc('get_email_log_search_page', {
      p_type: type,
      p_status: status,
      p_search: search,
      p_page: pagination.page,
      p_page_size: pagination.pageSize,
    }),
    supabase.rpc('get_email_log_summary', { p_type: type, p_status: status, p_search: search }),
  ])

  if (listResult.error) return NextResponse.json({ error: listResult.error.message }, { status: 500 })
  if (summaryResult.error) return NextResponse.json({ error: summaryResult.error.message }, { status: 500 })

  const report = listResult.data && typeof listResult.data === 'object'
    ? listResult.data as { data?: unknown; total?: unknown }
    : {}
  return NextResponse.json({
    data: Array.isArray(report.data) ? report.data : [],
    total: Number(report.total ?? 0) || 0,
    page: pagination.page,
    page_size: pagination.pageSize,
    summary: summaryResult.data,
  })
}
