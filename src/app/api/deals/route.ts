import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolvePagination } from '@/lib/pagination'
import { normalizeSearchTerm } from '@/lib/search'

export async function GET(request: NextRequest): Promise<NextResponse> {
  const supabase = await createClient()
  const pagination = resolvePagination({
    page: request.nextUrl.searchParams.get('page'),
    pageSize: request.nextUrl.searchParams.get('page_size'),
  })

  const { data: result, error } = await supabase.rpc('get_deals_search_page', {
    p_search: normalizeSearchTerm(request.nextUrl.searchParams.get('search')),
    p_page: pagination.page,
    p_page_size: pagination.pageSize,
  })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const report = result && typeof result === 'object'
    ? result as { data?: unknown; total?: unknown; summary?: unknown }
    : {}
  return NextResponse.json({
    data: Array.isArray(report.data) ? report.data : [],
    total: Number(report.total ?? 0) || 0,
    page: pagination.page,
    page_size: pagination.pageSize,
    summary: report.summary ?? {},
  })
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const supabase = await createClient()
  const body = await request.json() as {
    lead_id: string
    deal_value: number
    deal_type: string
    notes?: string
  }

  const { data, error } = await supabase
    .from('deals')
    .insert(body)
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Also update the lead status to closed
  await supabase
    .from('leads')
    .update({
      status: 'closed',
      deal_value: body.deal_value,
      deal_type: body.deal_type,
    })
    .eq('id', body.lead_id)

  return NextResponse.json({ data })
}

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  const supabase = await createClient()
  const body = await request.json() as { id: string; [key: string]: unknown }

  const { id, ...updates } = body

  const { data, error } = await supabase
    .from('deals')
    .update(updates)
    .eq('id', id)
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ data })
}
