import { schedules } from '@trigger.dev/sdk/v3'
import { sendDailyDigest } from '../agents/tracker'
import { assertTriggerJobsEnabled } from '../src/lib/side-effect-safety'
import { createServiceClient } from '../src/lib/supabase/server'

// Runs daily at 10:30am AEST — after pipeline (8am) and followup-job (9am) both complete
export const digestJob = schedules.task({
  id: 'digest-job',
  cron: {
    pattern: '30 10 * * *',
    timezone: 'Australia/Sydney',
  },
  queue: {
    name: 'digest-job',
    concurrencyLimit: 1,
  },
  maxDuration: 300,
  run: async () => {
    assertTriggerJobsEnabled('scheduled digest job')
    const control = createServiceClient()
    const { data: workspaces, error } = await control.from('workspaces').select('id').eq('status', 'active').order('created_at')
    if (error) throw new Error(`Digest workspace resolution failed: ${error.message}`)
    console.log('Sending daily digests...')
    for (const workspace of workspaces ?? []) await sendDailyDigest(workspace.id)
    console.log('Daily digest sent')
  },
})
