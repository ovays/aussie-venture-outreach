import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function GET(request: NextRequest): Promise<NextResponse> {
  const supabase = await createClient()
  const { searchParams } = new URL(request.url)

  const status = searchParams.get('status')
  const platform = searchParams.get('platform')
  const city = searchParams.get('city')

  let query = supabase
    .from('dm_queue')
    .select('*, leads(business_name, category_name, city, suburb)', { count: 'exact' })
    .order('created_at', { ascending: false })

  if (status) query = query.eq('status', status)
  if (platform) query = query.eq('platform', platform)

  const { data, error, count } = await query

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  let filtered = data ?? []
  if (city) {
    filtered = filtered.filter((d) => {
      const lead = d.leads as { city?: string } | null
      return lead?.city === city
    })
  }

  return NextResponse.json({ data: filtered, count })
}

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  const supabase = await createClient()
  const body = await request.json() as { id: string; status: 'sent' | 'skipped' | 'pending' }

  const update: Record<string, unknown> = { status: body.status }
  if (body.status === 'sent') {
    update.sent_at = new Date().toISOString()
  }

  const { data, error } = await supabase
    .from('dm_queue')
    .update(update)
    .eq('id', body.id)
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ data })
}
