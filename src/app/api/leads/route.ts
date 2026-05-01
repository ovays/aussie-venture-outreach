import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function GET(request: NextRequest): Promise<NextResponse> {
  const supabase = await createClient()
  const { searchParams } = new URL(request.url)

  const status = searchParams.get('status')
  const category = searchParams.get('category')
  const city = searchParams.get('city')
  const search = searchParams.get('search')
  const page = parseInt(searchParams.get('page') ?? '1', 10)
  const limit = 50
  const offset = (page - 1) * limit

  let query = supabase.from('leads').select('*', { count: 'exact' })

  if (status) query = query.eq('status', status)
  if (category) query = query.eq('category_name', category)
  if (city) query = query.eq('city', city)
  if (search) query = query.ilike('business_name', `%${search}%`)

  query = query.order('created_at', { ascending: false }).range(offset, offset + limit - 1)

  const { data, error, count } = await query

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ data, count, page, limit })
}

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  const supabase = await createClient()
  const body = await request.json() as { id: string; [key: string]: unknown }

  const { id, ...updates } = body

  const { data, error } = await supabase
    .from('leads')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ data })
}
