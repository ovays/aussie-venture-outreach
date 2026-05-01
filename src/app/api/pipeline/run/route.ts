import { NextResponse } from 'next/server'
import { tasks } from '@trigger.dev/sdk/v3'
import type { dailyPipeline } from '../../../../../trigger/daily-pipeline'

export const maxDuration = 30

export async function POST() {
  try {
    const handle = await tasks.trigger<typeof dailyPipeline>('daily-pipeline', undefined)
    return NextResponse.json({ status: 'triggered', run_id: handle.id })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[pipeline] failed to trigger task:', err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
