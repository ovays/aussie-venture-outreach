import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'

// GET /api/leads/delete-by-date?date=YYYY-MM-DD — returns count for that date
export async function GET(request: NextRequest) {
  const date = request.nextUrl.searchParams.get('date')
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: 'date param required (YYYY-MM-DD)' }, { status: 400 })
  }

  const supabase = createServiceClient()
  const dayStart = `${date}T00:00:00.000Z`
  const dayEnd   = `${date}T23:59:59.999Z`

  const { count, error } = await supabase
    .from('leads')
    .select('*', { count: 'exact', head: true })
    .gte('created_at', dayStart)
    .lte('created_at', dayEnd)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ count: count ?? 0 })
}

// DELETE /api/leads/delete-by-date  body: { date: "YYYY-MM-DD" }
export async function DELETE(request: NextRequest) {
  const body = await request.json() as { date?: string }
  const { date } = body

  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: 'date required (YYYY-MM-DD)' }, { status: 400 })
  }

  const supabase = createServiceClient()
  const dayStart = `${date}T00:00:00.000Z`
  const dayEnd   = `${date}T23:59:59.999Z`

  // Get lead IDs for this date
  const { data: leads, error: fetchErr } = await supabase
    .from('leads')
    .select('id')
    .gte('created_at', dayStart)
    .lte('created_at', dayEnd)

  if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 })
  if (!leads?.length) return NextResponse.json({ deleted: 0 })

  const ids = leads.map((l) => l.id)

  // Delete child records first
  const childTables = ['emails', 'dm_queue', 'follow_ups'] as const
  for (const table of childTables) {
    try {
      await supabase.from(table).delete().in('lead_id', ids)
    } catch {
      // table may not exist — continue
    }
  }

  // Delete leads
  const { error: delErr } = await supabase.from('leads').delete().in('id', ids)
  if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 })

  return NextResponse.json({ deleted: ids.length })
}
