import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolvePagination } from '@/lib/pagination'
import { STAGE_STATUSES, type LeadStage } from '@/lib/lead-status'
import { normalizeSearchTerm } from '@/lib/search'

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
  const supabase = await createClient()
  const { data: result, error } = await supabase.rpc('get_pipeline_search_page', {
    p_statuses: [...statuses],
    p_search: normalizeSearchTerm(searchParams.get('search')),
    p_page: pagination.page,
    p_page_size: pagination.pageSize,
  })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const report = result && typeof result === 'object' ? result as { data?: unknown; total?: unknown } : {}
  return NextResponse.json({
    data: Array.isArray(report.data) ? report.data : [],
    total: Number(report.total ?? 0) || 0,
    page: pagination.page,
    page_size: pagination.pageSize,
  })
}
