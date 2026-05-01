import { schedules } from '@trigger.dev/sdk/v3'
import { runFinderAgent } from '../agents/finder'
import { runResearcherAgent } from '../agents/researcher'
import { runWriterAgent } from '../agents/writer'
import { runSenderAgent } from '../agents/sender'

// Runs daily at 8:00am AEST (UTC+10/+11)
// 8:00am AEST = 22:00 UTC (AEDT, UTC+11) or 22:00 UTC (AEST, UTC+10)
// Using UTC cron - Sydney switches between AEST (UTC+10) and AEDT (UTC+11)
// 8am AEST = 22:00 UTC | 8am AEDT = 21:00 UTC
// Use 21:00 UTC to cover both (runs at 7am in winter, 8am in summer - close enough)
export const dailyPipeline = schedules.task({
  id: 'daily-pipeline',
  cron: {
    pattern: '0 21 * * *',
    timezone: 'Australia/Sydney',
  },
  maxDuration: 3600,
  run: async () => {
    console.log('Starting daily pipeline...')

    console.log('Step 1: Finder agent')
    await runFinderAgent()

    console.log('Step 2: Researcher agent')
    await runResearcherAgent()

    console.log('Step 3: Writer agent')
    await runWriterAgent()

    console.log('Step 4: Sender agent')
    await runSenderAgent()

    console.log('Daily pipeline complete')
  },
})
