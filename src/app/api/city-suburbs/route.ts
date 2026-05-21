import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'

export async function GET() {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('city_suburbs')
    .select('id, city, suburb, active, priority')
    .order('city')
    .order('suburb')

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const grouped: Record<string, { id: string; suburb: string; active: boolean; priority: number }[]> = {}
  for (const row of data ?? []) {
    if (!grouped[row.city]) grouped[row.city] = []
    const r = row as typeof row & { priority?: number | null }
    grouped[row.city].push({ id: row.id, suburb: row.suburb, active: row.active, priority: r.priority ?? 1 })
  }

  return NextResponse.json({ data: grouped })
}

export async function POST(req: NextRequest) {
  const supabase = createServiceClient()
  const { city, suburb } = await req.json() as { city: string; suburb: string }

  const { data, error } = await supabase
    .from('city_suburbs')
    .insert({ city, suburb, active: true })
    .select('id, city, suburb, active, priority')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ data })
}

export async function PATCH(req: NextRequest) {
  const supabase = createServiceClient()
  const body = await req.json() as { id: string; active?: boolean; priority?: number }

  const updates: Record<string, unknown> = {}
  if (body.active !== undefined) updates.active = body.active
  if (body.priority !== undefined) updates.priority = body.priority

  const { error } = await supabase
    .from('city_suburbs')
    .update(updates)
    .eq('id', body.id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

export async function DELETE(req: NextRequest) {
  const supabase = createServiceClient()
  const { id } = await req.json() as { id: string }

  const { error } = await supabase
    .from('city_suburbs')
    .delete()
    .eq('id', id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
