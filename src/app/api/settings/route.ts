import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function GET(): Promise<NextResponse> {
  const supabase = await createClient()

  const { data, error } = await supabase.from('settings').select('*').order('key')

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ data })
}

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  const supabase = await createClient()
  const body = await request.json() as { key: string; value: string }

  const { data, error } = await supabase
    .from('settings')
    .update({ value: body.value, updated_at: new Date().toISOString() })
    .eq('key', body.key)
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ data })
}
