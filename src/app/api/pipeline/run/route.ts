import { NextResponse } from 'next/server'
import { tasks, auth } from '@trigger.dev/sdk/v3'
import type { dailyPipelineJob } from '../../../../../trigger/daily-pipeline'

export const maxDuration = 30

export async function POST() {
  try {
    // TRIGGER_SECRET_KEY_PROD targets production when running locally (where TRIGGER_SECRET_KEY is a dev key).
    // On Vercel, set TRIGGER_SECRET_KEY to the prod key and omit TRIGGER_SECRET_KEY_PROD.
    const secretKey = process.env.TRIGGER_SECRET_KEY_PROD ?? process.env.TRIGGER_SECRET_KEY ?? ''

    const handle = await auth.withAuth(
      { accessToken: secretKey },
      () => tasks.trigger<typeof dailyPipelineJob>('daily-pipeline', {
        type: 'IMPERATIVE',
        timestamp: new Date(),
        timezone: 'Australia/Sydney',
        scheduleId: 'manual',
        upcoming: [],
      }),
    )

    return NextResponse.json({ status: 'triggered', run_id: handle.id })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[pipeline] failed to trigger task:', err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
