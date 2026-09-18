import { NextRequest, NextResponse } from 'next/server'
import { tasks, auth } from '@trigger.dev/sdk/v3'
import { checkRateLimit } from '@/lib/rateLimit'
import type { dailyPipelineJob } from '../../../../../trigger/daily-pipeline'
import { assertTriggerJobsEnabled } from '@/lib/side-effect-safety'

export const maxDuration = 30

export async function POST(request: NextRequest) {
  assertTriggerJobsEnabled('manual pipeline trigger')
  const ip = request.headers.get('x-forwarded-for') ?? request.headers.get('x-real-ip') ?? 'global'
  const { allowed } = checkRateLimit(`pipeline:${ip}`, 3)
  if (!allowed) {
    return NextResponse.json({ error: 'Rate limit exceeded — max 3 triggers per minute' }, { status: 429 })
  }

  try {
    const secretKey = process.env.TRIGGER_SECRET_KEY ?? ''

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
