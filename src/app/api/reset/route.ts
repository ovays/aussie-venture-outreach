import { NextResponse } from 'next/server'
import { isApiWorkspaceError, requireApiWorkspaceAdmin } from '@/lib/api-workspace'

const TABLES = ['emails', 'dm_queue', 'follow_ups', 'activity_log', 'deals'] as const

export async function POST() {
  const access = await requireApiWorkspaceAdmin()
  if (isApiWorkspaceError(access)) return access

  try {
    const { supabase } = access
    const results: Record<string, string> = {}

    // Delete child tables individually — a missing table won't block the others
    for (const table of TABLES) {
      try {
        const { error } = await supabase.from(table).delete().not('id', 'is', null)
        results[table] = error ? `error: ${error.message}` : 'cleared'
      } catch (e) {
        results[table] = `skipped: ${String(e)}`
      }
    }

    // Delete leads last (other tables reference it via lead_id)
    try {
      const { error } = await supabase.from('leads').delete().not('id', 'is', null)
      results['leads'] = error ? `error: ${error.message}` : 'cleared'
    } catch (e) {
      results['leads'] = `skipped: ${String(e)}`
    }

    console.log('[reset] Results:', results)

    return NextResponse.json({ success: true, message: 'All data cleared', tables: results })
  } catch (error) {
    console.error('[reset] Fatal error:', error)
    return NextResponse.json({ error: String(error) }, { status: 500 })
  }
}
