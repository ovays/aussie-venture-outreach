import { task, schedules } from '@trigger.dev/sdk/v3'
import { runFinderAgent } from '../agents/finder'
import { runWriterAgent } from '../agents/writer'
import { runSenderAgent } from '../agents/sender'

export const dailyPipeline = task({
  id: 'daily-pipeline',
  maxDuration: 3600,
  run: async () => {
    console.log('Starting daily pipeline...')

    console.log('Step 1: Finder agent (find + enrich inline, quota-filling)')
    await runFinderAgent()

    console.log('Step 2: Writer agent (writes outreach content)')
    await runWriterAgent()

    console.log('Step 3: Sender agent (sends emails)')
    await runSenderAgent()

    console.log('Daily pipeline complete')
  },
})

// Runs daily at 8:00am Sydney time
export const dailyPipelineSchedule = schedules.task({
  id: 'daily-pipeline-schedule',
  cron: {
    pattern: '0 21 * * *',
    timezone: 'Australia/Sydney',
  },
  maxDuration: 60,
  run: async () => {
    await dailyPipeline.trigger()
  },
})
