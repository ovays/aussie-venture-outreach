import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()
  const updates = await request.json() as Record<string, unknown>

  const { data, error } = await supabase
    .from('leads')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  if (updates.status === 'closed_manual') {
    await supabase.from('dm_queue').update({ status: 'skipped' }).eq('lead_id', id).eq('status', 'pending')
    await supabase.from('follow_ups').update({ status: 'cancelled' }).eq('lead_id', id).eq('status', 'scheduled')
  }

  return NextResponse.json({ data })
}
