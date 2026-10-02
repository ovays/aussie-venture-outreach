import { NextRequest, NextResponse } from 'next/server'
import { resolvePagination } from '@/lib/pagination'
import { normalizeSearchTerm } from '@/lib/search'
import { isApiWorkspaceError, requireApiWorkspacePlatformAdmin } from '@/lib/api-workspace'

export async function GET(request: NextRequest): Promise<NextResponse> {
  const access = await requireApiWorkspacePlatformAdmin()
  if (isApiWorkspaceError(access)) return access
  const { supabase, workspace } = access
  const { searchParams } = request.nextUrl
  const type = searchParams.get('type') || null
  const status = searchParams.get('status') || null
  const search = normalizeSearchTerm(searchParams.get('search'))
  const pagination = resolvePagination({ page: searchParams.get('page'), pageSize: searchParams.get('page_size') })

  const listResult = await supabase.rpc('get_email_log_search_page', {
    p_type: type ?? undefined,
    p_status: status ?? undefined,
    p_search: search,
    p_page: pagination.page,
    p_page_size: pagination.pageSize,
    p_workspace_id: workspace.workspaceId,
  })

  if (listResult.error) return NextResponse.json({ error: listResult.error.message }, { status: 500 })

  const report = listResult.data && typeof listResult.data === 'object'
    ? listResult.data as { data?: unknown; total?: unknown; summary?: unknown }
    : {}
  const metadataRows = (Array.isArray(report.data) ? report.data : []).map((raw) => {
    const row = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
    return { id: row.id, type: row.type, status: row.status, sent_at: row.sent_at, replied_at: row.replied_at, created_at: row.created_at }
  })
  return NextResponse.json({
    data: metadataRows,
    total: Number(report.total ?? 0) || 0,
    page: pagination.page,
    page_size: pagination.pageSize,
    summary: report.summary ?? {},
  })
}
