import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function GET(request: NextRequest): Promise<NextResponse> {
  const supabase = await createClient()
  const { searchParams } = new URL(request.url)

  const type = searchParams.get('type')
  const status = searchParams.get('status')

  let query = supabase
    .from('emails')
    .select('*, leads(business_name, category_name, city)', { count: 'exact' })
    .order('created_at', { ascending: false })
    .limit(500)

  if (type) query = query.eq('type', type)
  if (status) query = query.eq('status', status)

  const { data, error, count } = await query

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ data, count })
}
