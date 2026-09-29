import { NextRequest, NextResponse } from 'next/server'
import { resolvePagination } from '@/lib/pagination'
import { normalizeSearchTerm } from '@/lib/search'
import { isApiWorkspaceError, requireApiWorkspacePlatformAdmin } from '@/lib/api-workspace'

export async function GET(request: NextRequest): Promise<NextResponse> {
  const access = await requireApiWorkspacePlatformAdmin()
  if (isApiWorkspaceError(access)) return access
  const { supabase, workspace } = access
  const { searchParams } = new URL(request.url)

  const status = searchParams.get('status')
  const platform = searchParams.get('platform')
  const city = searchParams.get('city')
  const pagination = resolvePagination({
    page: searchParams.get('page'),
    pageSize: searchParams.get('page_size'),
  })
  const { data: result, error } = await supabase.rpc('get_dm_queue_search_page', {
    p_status: status ?? undefined,
    p_platform: platform ?? undefined,
    p_city: city ?? undefined,
    p_search: normalizeSearchTerm(searchParams.get('search')),
    p_page: pagination.page,
    p_page_size: pagination.pageSize,
    p_workspace_id: workspace.workspaceId,
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
  const access = await requireApiWorkspacePlatformAdmin()
  if (isApiWorkspaceError(access)) return access
  const { supabase, workspace } = access
  const body = await request.json() as { id: string; status: 'sent' | 'skipped' | 'pending' }

  const update: { status: 'sent' | 'skipped' | 'pending'; sent_at?: string } = { status: body.status }
  if (body.status === 'sent') {
    update.sent_at = new Date().toISOString()
  }

  const { data, error } = await supabase
    .from('dm_queue')
    .update(update)
    .eq('workspace_id', workspace.workspaceId)
    .eq('id', body.id)
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ data })
}
