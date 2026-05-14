import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { checkRateLimit } from '@/lib/rateLimit'

const patchLeadSchema = z.object({
  id: z.string().uuid(),
}).catchall(z.unknown())

export async function GET(request: NextRequest): Promise<NextResponse> {
  const ip = request.headers.get('x-forwarded-for') ?? request.headers.get('x-real-ip') ?? 'global'
  const { allowed } = checkRateLimit(`leads:${ip}`, 60)
  if (!allowed) return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 })

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
  const ip = request.headers.get('x-forwarded-for') ?? request.headers.get('x-real-ip') ?? 'global'
  const { allowed } = checkRateLimit(`leads:${ip}`, 60)
  if (!allowed) return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 })

  const supabase = await createClient()
  const raw = await request.json()

  const parsed = patchLeadSchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request body', issues: parsed.error.issues }, { status: 400 })
  }

  const { id, ...updates } = parsed.data

  const { data, error } = await supabase
    .from('leads')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  if (updates.status === 'closed_manual') {
    await supabase.from('dm_queue').update({ status: 'skipped' }).eq('lead_id', id).eq('status', 'pending')
    await supabase.from('follow_ups').update({ status: 'cancelled' }).eq('lead_id', id).eq('status', 'scheduled')
  }

  return NextResponse.json({ data })
}
