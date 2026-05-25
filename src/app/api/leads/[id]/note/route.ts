import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()
  const { text } = await request.json() as { text: string }

  if (!text?.trim()) return NextResponse.json({ error: 'Note text required' }, { status: 400 })

  const { data, error } = await supabase
    .from('activity_log')
    .insert({
      lead_id: id,
      event_type: 'note_added',
      description: text.trim(),
      created_at: new Date().toISOString(),
    })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ data })
}
