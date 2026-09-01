import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { DATA_QUALITY_ISSUE_TYPES } from '@/lib/data-quality'
import { enrichDataQualityRows, type DataQualityReportRow } from '@/lib/data-quality-report'
import { isAuthErrorResponse, requireApiAdmin } from '@/lib/auth'

function positiveInt(value: string | null, fallback: number, max: number): number {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = await requireApiAdmin()
  if (isAuthErrorResponse(auth)) return auth
  const params = request.nextUrl.searchParams
  const issueType = params.get('issue_type')
  if (issueType && !DATA_QUALITY_ISSUE_TYPES.includes(issueType as never)) {
    return NextResponse.json({ error: 'Invalid issue_type' }, { status: 400 })
  }
  const page = positiveInt(params.get('page'), 1, 1_000_000)
  const pageSize = positiveInt(params.get('page_size'), 50, 100)
  const supabase = createServiceClient()
  const [reportResult, summaryResult] = await Promise.all([
    supabase.rpc('get_data_quality_report_v2', {
      p_issue_type: issueType || null,
      p_search: params.get('search') || null,
      p_email: params.get('email') || null,
      p_business: params.get('business') || null,
      p_category: params.get('category') || null,
      p_city: params.get('city') || null,
      p_page: page,
      p_page_size: pageSize,
    }),
    supabase.rpc('get_data_quality_summary'),
  ])
  if (reportResult.error || summaryResult.error) {
    console.error('Data Quality report RPC failed', {
      report: reportResult.error?.message,
      summary: summaryResult.error?.message,
      userId: auth.user.id,
    })
    return NextResponse.json({ error: 'Unable to load the Data Quality report. Please try again.' }, { status: 500 })
  }
  const data = reportResult.data
  const report = data && typeof data === 'object' ? data as Record<string, unknown> : {}
  let rows: DataQualityReportRow[]
  try {
    rows = await enrichDataQualityRows(
      supabase,
      (Array.isArray(report.data) ? report.data : []) as DataQualityReportRow[],
    )
  } catch (error) {
    console.error('Data Quality detail enrichment failed', { error, userId: auth.user.id })
    return NextResponse.json({ error: 'Unable to load related lead details. Please try again.' }, { status: 500 })
  }
  const total = Number(report.total ?? 0) || 0
  return NextResponse.json({
    data: rows, total, page, page_size: pageSize,
    total_pages: Math.ceil(total / pageSize), summary: summaryResult.data ?? {},
  })
}
