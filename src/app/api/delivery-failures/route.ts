import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import {
  mapDeliveryFailureRow,
  normalizeDeliveryFailureSummary,
  parseDeliveryFailureFilters,
} from '@/lib/delivery-failure-report'
import { escapePostgresLikeTerm } from '@/lib/search'

interface ReportRpcResult {
  data?: unknown
  total?: unknown
  page?: unknown
  page_size?: unknown
  summary?: unknown
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const filters = parseDeliveryFailureFilters(request.nextUrl.searchParams)
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('get_delivery_failure_report', {
    p_status: filters.status,
    p_email_type: filters.emailType,
    p_search: escapePostgresLikeTerm(filters.search),
    p_page: filters.page,
    p_page_size: filters.pageSize,
  })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const report = data && typeof data === 'object' ? data as ReportRpcResult : {}
  const rows = Array.isArray(report.data) ? report.data : []
  const total = Number(report.total ?? 0) || 0

  return NextResponse.json({
    data: rows.map((row) => mapDeliveryFailureRow(row as Record<string, unknown>)),
    total,
    page: Number(report.page ?? filters.page) || filters.page,
    page_size: Number(report.page_size ?? filters.pageSize) || filters.pageSize,
    total_pages: Math.ceil(total / filters.pageSize),
    summary: normalizeDeliveryFailureSummary(report.summary),
  })
}
