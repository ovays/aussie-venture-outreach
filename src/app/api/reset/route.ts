import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'

export async function POST() {
  try {
    const supabase = createServiceClient()

    // Delete child tables first (foreign key constraints reference leads)
    await Promise.all([
      supabase.from('emails').delete().not('id', 'is', null),
      supabase.from('dm_queue').delete().not('id', 'is', null),
      supabase.from('follow_ups').delete().not('id', 'is', null),
      supabase.from('activity_log').delete().not('id', 'is', null),
      supabase.from('deals').delete().not('id', 'is', null),
    ])

    // Delete leads after dependents are cleared
    await supabase.from('leads').delete().not('id', 'is', null)

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('[reset] Error:', error)
    return NextResponse.json({ error: String(error) }, { status: 500 })
  }
}
