import { schedules } from '@trigger.dev/sdk/v3'
import { sendDailyDigest } from '../agents/tracker'

// Runs daily at 8:00am AEST
export const digestJob = schedules.task({
  id: 'digest-job',
  cron: {
    pattern: '0 8 * * *',
    timezone: 'Australia/Sydney',
  },
  maxDuration: 300,
  run: async () => {
    console.log('Sending daily digest...')
    await sendDailyDigest()
    console.log('Daily digest sent')
  },
})
