import { NextRequest, NextResponse } from 'next/server'
import { parseDeliveryFailureFilters } from '@/lib/delivery-failure-report'
import { escapePostgresLikeTerm } from '@/lib/search'
import { isApiWorkspaceError, requireApiWorkspaceUser } from '@/lib/api-workspace'

interface LeadSelectionRpcResult {
  count?: unknown
  lead_ids?: unknown
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const access = await requireApiWorkspaceUser()
  if (isApiWorkspaceError(access)) return access

  const filters = parseDeliveryFailureFilters(request.nextUrl.searchParams)
  const includeIds = request.nextUrl.searchParams.get('include_ids') === 'true'
  const { supabase, workspace } = access
  const { data, error } = await supabase.rpc('get_delivery_failure_lead_selection', {
    p_status: filters.status ?? undefined,
    p_email_type: filters.emailType ?? undefined,
    p_search: escapePostgresLikeTerm(filters.search),
    p_include_ids: includeIds,
    p_workspace_id: workspace.workspaceId,
  })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const selection = data && typeof data === 'object' ? data as LeadSelectionRpcResult : {}
  const leadIds = includeIds && Array.isArray(selection.lead_ids)
    ? selection.lead_ids.filter((value): value is string => typeof value === 'string')
    : []

  return NextResponse.json({
    count: Number(selection.count ?? 0) || 0,
    lead_ids: leadIds,
  })
}
