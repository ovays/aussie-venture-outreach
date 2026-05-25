import { schedules } from "@trigger.dev/sdk/v3"
import { runFinderAgent } from "../agents/finder"
import { runResearcherAgent } from "../agents/researcher"
import { runWriterAgent } from "../agents/writer"
import { runSenderAgent } from "../agents/sender"
import { runFollowUpAgent } from "../agents/followup"
import { runReactivationAgent } from "../agents/reactivation"

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

    // ── Discovery pipeline (stages 1–4) ────────────────────────────────────
    // Finder discovers leads → Researcher enriches → Writer drafts emails →
    // Sender delivers initial outreach.
    //
    // Errors in these stages are logged but do NOT block the follow-up queue,
    // which must always run to service previously-contacted leads regardless of
    // today's initial outreach quota.
    //
    // Exception: a 402 (Outscraper balance exhausted) is fatal — it aborts
    // everything including follow-up to prevent charging further.

    try {
      console.log("[PIPELINE_STAGE] Finder starting")
      leadsFound = await runFinderAgent()
      console.log("[PIPELINE_STAGE] Finder complete", { leadsFound })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes("402")) throw new Error(`Pipeline failed at Finder: ${message}`)
      console.error("PIPELINE ERROR at Finder (follow-up will still run):", message)
    }

    try {
      console.log("[PIPELINE_STAGE] Researcher starting", { leadsFound })
      const researched = await runResearcherAgent()
      console.log("[PIPELINE_STAGE] Researcher complete", { researched })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error("PIPELINE ERROR at Researcher (follow-up will still run):", message)
    }

    try {
      console.log("[PIPELINE_STAGE] Writer starting")
      await runWriterAgent()
      console.log("[PIPELINE_STAGE] Writer complete")
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error("PIPELINE ERROR at Writer (follow-up will still run):", message)
    }

    try {
      console.log("[PIPELINE_STAGE] Sender starting")
      const senderResult = await runSenderAgent()
      console.log("[PIPELINE_STAGE] Sender complete", senderResult)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error("PIPELINE ERROR at Sender (follow-up will still run):", message)
    }

    // ── Follow-up pipeline (stage 5) ────────────────────────────────────────
    // Always executes — independent of whether discovery stages found anything
    // or hit their quotas. FU1/FU2/FU3 each log their own start/complete via
    // [PIPELINE_STAGE] inside runFollowUpAgent.

    try {
      console.log("[PIPELINE_STAGE] Follow-up starting")
      await runFollowUpAgent()
      console.log("[PIPELINE_STAGE] Follow-up complete")
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error("PIPELINE FAILED at Follow-up:", error)
      throw new Error(`Pipeline failed at Follow-up: ${message}`)
    }

    // ── Reactivation pipeline (stage 6) ────────────────────────────────────

    try {
      console.log("[PIPELINE_STAGE] Reactivation starting")
      await runReactivationAgent()
      console.log("[PIPELINE_STAGE] Reactivation complete")
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error("PIPELINE FAILED at Reactivation:", error)
      throw new Error(`Pipeline failed at Reactivation: ${message}`)
    }

    console.log("[PIPELINE_STAGE] Pipeline complete", { reason: "all_stages_finished", leadsFound })
    return { leadsFound }
  }
})
