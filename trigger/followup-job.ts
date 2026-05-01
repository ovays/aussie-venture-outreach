import { schedules } from '@trigger.dev/sdk/v3'
import { runFollowUpAgent } from '../agents/followup'

// Runs daily at 9:00am AEST
export const followupJob = schedules.task({
  id: 'followup-job',
  cron: {
    pattern: '0 9 * * *',
    timezone: 'Australia/Sydney',
  },
  maxDuration: 1800,
  run: async () => {
    console.log('Starting follow-up agent...')
    await runFollowUpAgent()
    console.log('Follow-up agent complete')
  },
})
