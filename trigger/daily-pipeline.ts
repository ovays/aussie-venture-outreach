import { schedules } from "@trigger.dev/sdk/v3"
import { runFinderAgent } from "../agents/finder"
import { runResearcherAgent } from "../agents/researcher"
import { runWriterAgent } from "../agents/writer"
import { runSenderAgent } from "../agents/sender"
import { runFollowUpAgent } from "../agents/followup"

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
      console.log("[PIPELINE_STAGE] Finder starting")
      leadsFound = await runFinderAgent()
      console.log("[PIPELINE_STAGE] Finder complete", { leadsFound })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error("PIPELINE FAILED at Step 1 (Finder):", error)
      throw new Error(`Pipeline failed at Finder: ${message}`)
    }

    try {
      console.log("[PIPELINE_STAGE] Researcher starting", { leadsFound })
      const researched = await runResearcherAgent()
      console.log("[PIPELINE_STAGE] Researcher complete", { researched })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error("PIPELINE FAILED at Step 2 (Researcher):", error)
      throw new Error(`Pipeline failed at Researcher: ${message}`)
    }

    try {
      console.log("[PIPELINE_STAGE] Writer starting")
      await runWriterAgent()
      console.log("[PIPELINE_STAGE] Writer complete")
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error("PIPELINE FAILED at Step 3 (Writer):", error)
      throw new Error(`Pipeline failed at Writer: ${message}`)
    }

    try {
      console.log("[PIPELINE_STAGE] Sender starting")
      const senderResult = await runSenderAgent()
      console.log("[PIPELINE_STAGE] Sender complete", senderResult)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error("PIPELINE FAILED at Step 4 (Sender):", error)
      throw new Error(`Pipeline failed at Sender: ${message}`)
    }

    try {
      console.log("Step 5: Follow-up agent")
      await runFollowUpAgent()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error("PIPELINE FAILED at Step 5 (Follow-up):", error)
      throw new Error(`Pipeline failed at Follow-up: ${message}`)
    }

    console.log("[PIPELINE_STAGE] Pipeline complete", { reason: "all_stages_finished", leadsFound })
    return { leadsFound }
  }
})
