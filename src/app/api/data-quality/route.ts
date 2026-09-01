import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { DATA_QUALITY_ISSUE_TYPES } from '@/lib/data-quality'
import { isAuthErrorResponse, requireApiUser } from '@/lib/auth'

function positiveInt(value: string | null, fallback: number, max: number): number {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = await requireApiUser()
  if (isAuthErrorResponse(auth)) return auth
  const params = request.nextUrl.searchParams
  const issueType = params.get('issue_type')
  if (issueType && !DATA_QUALITY_ISSUE_TYPES.includes(issueType as never)) {
    return NextResponse.json({ error: 'Invalid issue_type' }, { status: 400 })
  }
  const page = positiveInt(params.get('page'), 1, 1_000_000)
  const pageSize = positiveInt(params.get('page_size'), 50, 200)
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('get_data_quality_report', {
    p_issue_type: issueType || null,
    p_email: params.get('email') || null,
    p_business: params.get('business') || null,
    p_category: params.get('category') || null,
    p_city: params.get('city') || null,
    p_page: page,
    p_page_size: pageSize,
  })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  const report = data && typeof data === 'object' ? data as Record<string, unknown> : {}
  let summary: unknown = undefined
  if (params.get('dry_run') === 'true') {
    const result = await supabase.rpc('get_data_quality_summary')
    if (result.error) return NextResponse.json({ error: result.error.message }, { status: 500 })
    summary = result.data
  }
  const total = Number(report.total ?? 0) || 0
  return NextResponse.json({
    data: Array.isArray(report.data) ? report.data : [], total, page, page_size: pageSize,
    total_pages: Math.ceil(total / pageSize), dry_run: params.get('dry_run') === 'true',
    ...(summary !== undefined ? { summary } : {}),
  })
}
