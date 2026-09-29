import { NextRequest, NextResponse } from 'next/server'
import { tasks, auth } from '@trigger.dev/sdk/v3'
import { checkRateLimit } from '@/lib/rateLimit'
import type { dailyPipelineJob } from '../../../../../trigger/daily-pipeline'
import { assertTriggerJobsEnabled } from '@/lib/side-effect-safety'
import { isAuthErrorResponse, requireApiAdmin } from '@/lib/auth'
import { executePipelineRunBoundary } from '@/lib/pipeline-run-boundary'

export const maxDuration = 30

export async function POST(request: NextRequest) {
  const ip = request.headers.get('x-forwarded-for') ?? request.headers.get('x-real-ip') ?? 'global'
  const result = await executePipelineRunBoundary({
    authorize: async () => {
      const admin = await requireApiAdmin()
      if (isAuthErrorResponse(admin)) {
        return {
          allowed: false as const,
          status: admin.status === 401 ? 401 as const : 403 as const,
          error: admin.status === 401 ? 'Authentication required' : 'Admin access required',
        }
      }
      return { allowed: true as const }
    },
    assertJobsEnabled: assertTriggerJobsEnabled,
    rateLimit: () => checkRateLimit(`pipeline:${ip}`, 3).allowed,
    trigger: async () => {
      const secretKey = process.env.TRIGGER_SECRET_KEY ?? ''
      return auth.withAuth(
        { accessToken: secretKey },
        () => tasks.trigger<typeof dailyPipelineJob>('daily-pipeline', {
          type: 'IMPERATIVE',
          timestamp: new Date(),
          timezone: 'Australia/Sydney',
          scheduleId: 'manual',
          upcoming: [],
        }),
      )
    },
  })

  if (result.status === 500) console.error('[pipeline] failed to trigger task:', result.body.error)
  return NextResponse.json(result.body, { status: result.status })
}
