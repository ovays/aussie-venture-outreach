import { schedules } from '@trigger.dev/sdk/v3'
import { sendDailyDigest } from '../agents/tracker'
import { assertTriggerJobsEnabled } from '../src/lib/side-effect-safety'

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
    console.log('Sending daily digest...')
    await sendDailyDigest()
    console.log('Daily digest sent')
  },
})
