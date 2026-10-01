import { NextRequest, NextResponse } from 'next/server'
import { isApiWorkspaceError, requireApiWorkspaceUser } from '@/lib/api-workspace'
import { isCustomerLeadFilter } from '@/lib/customer-lead'
import { normalizeSearchTerm } from '@/lib/search'
import { resolvePagination } from '@/lib/pagination'

export async function GET(request: NextRequest): Promise<NextResponse> {
  const access = await requireApiWorkspaceUser()
  if (isApiWorkspaceError(access)) return access

  const filterValue = request.nextUrl.searchParams.get('status') ?? 'all'
  if (!isCustomerLeadFilter(filterValue)) {
    return NextResponse.json({ error: 'Invalid customer lead status' }, { status: 400 })
  }
  const pagination = resolvePagination({
    page: request.nextUrl.searchParams.get('page'),
    pageSize: request.nextUrl.searchParams.get('page_size'),
  }, { defaultPageSize: 25, maxPageSize: 50 })

  const { data, error } = await access.supabase.rpc('get_customer_leads_page' as never, {
    p_workspace_id: access.workspace.workspaceId,
    p_status: filterValue,
    p_search: normalizeSearchTerm(request.nextUrl.searchParams.get('search')),
    p_page: pagination.page,
    p_page_size: pagination.pageSize,
    p_as_of: new Date().toISOString(),
  } as never)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  const report = data && typeof data === 'object' && !Array.isArray(data) ? data : {}
  return NextResponse.json(report)
}
