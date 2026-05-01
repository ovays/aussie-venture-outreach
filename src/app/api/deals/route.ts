import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function GET(): Promise<NextResponse> {
  const supabase = await createClient()

  const { data, error, count } = await supabase
    .from('deals')
    .select('*, leads(business_name, category_name, city, suburb)', { count: 'exact' })
    .order('closed_at', { ascending: false })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ data, count })
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
