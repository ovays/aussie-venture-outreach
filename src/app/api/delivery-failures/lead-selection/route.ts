import { NextRequest, NextResponse } from 'next/server'
import { isAuthErrorResponse, requireApiUser } from '@/lib/auth'
import { parseDeliveryFailureFilters } from '@/lib/delivery-failure-report'
import { escapePostgresLikeTerm } from '@/lib/search'
import { createClient } from '@/lib/supabase/server'

interface LeadSelectionRpcResult {
  count?: unknown
  lead_ids?: unknown
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = await requireApiUser()
  if (isAuthErrorResponse(auth)) return auth

  const filters = parseDeliveryFailureFilters(request.nextUrl.searchParams)
  const includeIds = request.nextUrl.searchParams.get('include_ids') === 'true'
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('get_delivery_failure_lead_selection', {
    p_status: filters.status,
    p_email_type: filters.emailType,
    p_search: escapePostgresLikeTerm(filters.search),
    p_include_ids: includeIds,
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
