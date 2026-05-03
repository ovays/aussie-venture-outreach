import { schedules } from "@trigger.dev/sdk/v3"
import { runFinderAgent } from "../agents/finder"
import { runResearcherAgent } from "../agents/researcher"
import { runWriterAgent } from "../agents/writer"
import { runSenderAgent } from "../agents/sender"

export const dailyPipelineJob = schedules.task({
  id: "daily-pipeline",
  cron: {
    pattern: "0 8 * * *",
    timezone: "Australia/Sydney",
  },
  maxDuration: 3600,
  run: async () => {
    console.log("Starting scheduled daily pipeline...")

    console.log("Step 1: Finder agent")
    const leadsFound = await runFinderAgent()

    console.log("Step 2: Researcher agent")
    await runResearcherAgent()

    console.log("Step 3: Writer agent")
    await runWriterAgent()

    console.log("Step 4: Sender agent")
    await runSenderAgent()

    console.log("Daily pipeline complete")
    return { leadsFound }
  }
})
