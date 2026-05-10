import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { isAuthErrorResponse, requireApiAdmin } from '@/lib/auth'

export async function GET() {
  const auth = await requireApiAdmin()
  if (isAuthErrorResponse(auth)) return auth

  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('city_suburbs')
    .select('id, city, suburb, active')
    .order('city')
    .order('suburb')

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const grouped: Record<string, { id: string; suburb: string; active: boolean }[]> = {}
  for (const row of data ?? []) {
    if (!grouped[row.city]) grouped[row.city] = []
    grouped[row.city].push({ id: row.id, suburb: row.suburb, active: row.active })
  }

  return NextResponse.json({ data: grouped })
}

export async function POST(req: NextRequest) {
  const auth = await requireApiAdmin()
  if (isAuthErrorResponse(auth)) return auth

  const supabase = createServiceClient()
  const { city, suburb } = await req.json() as { city: string; suburb: string }

  const { data, error } = await supabase
    .from('city_suburbs')
    .insert({ city, suburb, active: true })
    .select('id, city, suburb, active')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ data })
}

export async function PATCH(req: NextRequest) {
  const auth = await requireApiAdmin()
  if (isAuthErrorResponse(auth)) return auth

  const supabase = createServiceClient()
  const { id, active } = await req.json() as { id: string; active: boolean }

  const { error } = await supabase
    .from('city_suburbs')
    .update({ active })
    .eq('id', id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

export async function DELETE(req: NextRequest) {
  const auth = await requireApiAdmin()
  if (isAuthErrorResponse(auth)) return auth

  const supabase = createServiceClient()
  const { id } = await req.json() as { id: string }

  const { error } = await supabase
    .from('city_suburbs')
    .delete()
    .eq('id', id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
