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

    let leadsFound = 0

    try {
      console.log("Step 1: Finder agent")
      leadsFound = await runFinderAgent()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error("PIPELINE FAILED at Step 1 (Finder):", error)
      throw new Error(`Pipeline failed at Finder: ${message}`)
    }

    try {
      console.log("Step 2: Researcher agent")
      await runResearcherAgent()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error("PIPELINE FAILED at Step 2 (Researcher):", error)
      throw new Error(`Pipeline failed at Researcher: ${message}`)
    }

    try {
      console.log("Step 3: Writer agent")
      await runWriterAgent()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error("PIPELINE FAILED at Step 3 (Writer):", error)
      throw new Error(`Pipeline failed at Writer: ${message}`)
    }

    try {
      console.log("Step 4: Sender agent")
      await runSenderAgent()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error("PIPELINE FAILED at Step 4 (Sender):", error)
      throw new Error(`Pipeline failed at Sender: ${message}`)
    }

    console.log("Daily pipeline complete")
    return { leadsFound }
  }
})
