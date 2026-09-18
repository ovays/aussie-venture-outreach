import { schedules } from "@trigger.dev/sdk/v3"
import { runFinderAgent } from "../agents/finder"
import { runResearcherAgent } from "../agents/researcher"
import { runWriterAgent } from "../agents/writer"
import { runSenderAgent } from "../agents/sender"
import { runFollowUpAgent } from "../agents/followup"
import { runReactivationAgent } from "../agents/reactivation"
import { createServiceClient } from "../src/lib/supabase/server"
import { readInitialEmailMode } from "../src/lib/initial-email-router"
import { assertFinderScheduleEnabled, assertTriggerJobsEnabled } from "../src/lib/side-effect-safety"
import { acquireLock, releaseLock } from "../src/lib/distributed-lock"
import { observability, withObservedStep } from "../src/lib/observability/service"
import { withWorkflowTrace } from "../src/lib/observability/context"
import { readOrchestratorFlags, runConfiguredLeadBatch, selectOrchestrationCandidateIds } from "../src/domain/orchestrator"

const DAILY_PIPELINE_LOCK_KEY = "daily_pipeline"
const DAILY_PIPELINE_LOCK_TTL_MS = 70 * 60 * 1000

export const dailyPipelineJob = schedules.task({
  id: "daily-pipeline",
  cron: {
    pattern: "0 8 * * *",
    timezone: "Australia/Sydney",
  },
  // Prevents two overlapping runs of this task (a manual "Test Run" from the
  // dashboard racing the scheduled cron, or a duplicate schedule dispatch)
  // from both reaching Follow-up/Sender in parallel and double-sending to the
  // same lead. Application-level idempotency checks (agents/followup.ts,
  // agents/sender.ts) and the DB unique index (migration 027) are the other
  // two layers of the same defense.
  queue: {
    concurrencyLimit: 1,
  },
  maxDuration: 3600,
  run: async (_payload, { ctx }) => {
    assertTriggerJobsEnabled('scheduled daily pipeline')
    assertFinderScheduleEnabled('scheduled Finder run')
    const pipelineSupabase = createServiceClient()
    const telemetry = observability()
    const workflowRunId = await telemetry.startWorkflowRun({
      workflowType: 'daily_pipeline', source: ctx.run.isTest ? 'trigger.manual_test' : 'trigger.schedule', triggerTaskId: 'daily-pipeline',
      triggerRunId: ctx.run.id, correlationId: ctx.run.rootTaskRunId ?? ctx.run.id,
      idempotencyKey: ctx.run.idempotencyKey, attempt: ctx.attempt.number,
      metadata: { scheduled: true, is_test: ctx.run.isTest ?? false, is_replay: ctx.run.isReplay ?? false },
    })
    const pipelineLockToken = await acquireLock(
      pipelineSupabase, DAILY_PIPELINE_LOCK_KEY, DAILY_PIPELINE_LOCK_TTL_MS,
    )
    if (!pipelineLockToken) {
      console.log("[PIPELINE_STAGE] Pipeline skipped", { reason: "concurrent_run_in_progress" })
      await telemetry.completeWorkflowRun(workflowRunId, 'skipped', { reason: 'concurrent_run_in_progress' })
      return { leadsFound: 0, skipped: "concurrent_run_in_progress" }
    }

    const executePipeline = async () => {
    let hadPartialFailure = false
    try {
    console.log("Starting scheduled daily pipeline...")
    const initialEmailMode = await readInitialEmailMode(pipelineSupabase)
    const orchestratorFlags = readOrchestratorFlags()
    const orchestratorOwnsExecution = orchestratorFlags.enabled && !orchestratorFlags.shadow
    console.log("[INITIAL_EMAIL_MODE] Batch snapshot captured", { initial_email_mode: initialEmailMode })

    let leadsFound = 0
    let runtimeLimitHit = false

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
    //
    // When Finder hits the runtime limit, Researcher/Writer/Sender are skipped
    // to avoid cascading into a second long stage — Follow-up and Reactivation
    // still run regardless.

    try {
      console.log("[PIPELINE_STAGE] Finder starting")
      const finderResult = await withObservedStep(
        { stepName: 'finder', stepType: 'agent', sequence: 10, attempt: ctx.attempt.number },
        () => runFinderAgent(),
        (result) => result,
      )
      leadsFound = finderResult.leadsFound
      runtimeLimitHit = finderResult.runtimeLimitHit
      console.log("[PIPELINE_STAGE] Finder complete", { leadsFound, runtimeLimitHit })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes("402")) throw new Error(`Pipeline failed at Finder: ${message}`)
      hadPartialFailure = true
      console.error("PIPELINE ERROR at Finder (follow-up will still run):", message)
    }

    // Prompt 13: shadow comparison is intentionally isolated in the dedicated,
    // unscheduled v2-shadow-comparison task. This operational task never treats
    // ORCHESTRATOR_SHADOW as permission to compare or execute.
    if (orchestratorFlags.enabled && !orchestratorFlags.shadow) {
      const leadIds = await selectOrchestrationCandidateIds(pipelineSupabase, { limit: 100 })
      const orchestrated = await runConfiguredLeadBatch({
        leadIds,
        source: 'trigger.daily_pipeline',
        triggerRunId: ctx.run.id,
        parentRunId: workflowRunId ?? undefined,
        correlationId: ctx.run.rootTaskRunId ?? ctx.run.id,
        attempt: ctx.attempt.number,
      })
      console.log('[PIPELINE_STAGE] Orchestrator batch complete', {
        shadow: orchestratorFlags.shadow,
        selected: leadIds.length,
        failed: orchestrated.failedLeadIds.length,
      })
      if (orchestrated.failedLeadIds.length > 0) hadPartialFailure = true
    }

    if (orchestratorOwnsExecution) {
      await telemetry.skipWorkflowStep({ stepName: 'researcher', stepType: 'agent', sequence: 20 }, 'ORCHESTRATOR_ENABLED')
      await telemetry.skipWorkflowStep({ stepName: 'writer', stepType: 'agent', sequence: 30 }, 'ORCHESTRATOR_ENABLED')
      await telemetry.skipWorkflowStep({ stepName: 'sender', stepType: 'agent', sequence: 40 }, 'ORCHESTRATOR_ENABLED')
    } else if (runtimeLimitHit) {
      await telemetry.skipWorkflowStep({ stepName: 'researcher', stepType: 'agent', sequence: 20 }, 'FINDER_RUNTIME_LIMIT')
      await telemetry.skipWorkflowStep({ stepName: 'writer', stepType: 'agent', sequence: 30 }, 'FINDER_RUNTIME_LIMIT')
      await telemetry.skipWorkflowStep({ stepName: 'sender', stepType: 'agent', sequence: 40 }, 'FINDER_RUNTIME_LIMIT')
      console.log("[PIPELINE_STAGE] Skipping Researcher/Writer/Sender — Finder hit runtime limit")
    } else {
      try {
        console.log("[PIPELINE_STAGE] Researcher starting", { leadsFound })
        const researched = await withObservedStep(
          { stepName: 'researcher', stepType: 'agent', sequence: 20, attempt: ctx.attempt.number },
          () => runResearcherAgent(initialEmailMode),
          (count) => ({ processed: count }),
        )
        console.log("[PIPELINE_STAGE] Researcher complete", { researched })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        hadPartialFailure = true
        console.error("PIPELINE ERROR at Researcher (follow-up will still run):", message)
      }

      try {
        console.log("[PIPELINE_STAGE] Writer starting")
        await withObservedStep(
          { stepName: 'writer', stepType: 'agent', sequence: 30, attempt: ctx.attempt.number },
          () => runWriterAgent(initialEmailMode),
        )
        console.log("[PIPELINE_STAGE] Writer complete")
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        hadPartialFailure = true
        console.error("PIPELINE ERROR at Writer (follow-up will still run):", message)
      }

      try {
        console.log("[PIPELINE_STAGE] Sender starting")
        const senderResult = await withObservedStep(
          { stepName: 'sender', stepType: 'agent', sequence: 40, attempt: ctx.attempt.number },
          () => runSenderAgent(),
          (result) => result,
        )
        console.log("[PIPELINE_STAGE] Sender complete", senderResult)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        hadPartialFailure = true
        console.error("PIPELINE ERROR at Sender (follow-up will still run):", message)
      }
    }

    // ── Follow-up pipeline (stage 5) ────────────────────────────────────────
    // Always executes — independent of whether discovery stages found anything
    // or hit their quotas. FU1/FU2/FU3 each log their own start/complete via
    // [PIPELINE_STAGE] inside runFollowUpAgent.

    if (orchestratorOwnsExecution) {
      await telemetry.skipWorkflowStep({ stepName: 'followup', stepType: 'agent', sequence: 50 }, 'ORCHESTRATOR_ENABLED')
    } else try {
      console.log("[PIPELINE_STAGE] Follow-up starting")
      await withObservedStep(
        { stepName: 'followup', stepType: 'agent', sequence: 50, attempt: ctx.attempt.number },
        () => runFollowUpAgent(),
      )
      console.log("[PIPELINE_STAGE] Follow-up complete")
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error("PIPELINE FAILED at Follow-up:", error)
      throw new Error(`Pipeline failed at Follow-up: ${message}`)
    }

    // ── Reactivation pipeline (stage 6) ────────────────────────────────────

    if (orchestratorOwnsExecution) {
      await telemetry.skipWorkflowStep({ stepName: 'reactivation', stepType: 'agent', sequence: 60 }, 'ORCHESTRATOR_ENABLED')
    } else try {
      console.log("[PIPELINE_STAGE] Reactivation starting")
      await withObservedStep(
        { stepName: 'reactivation', stepType: 'agent', sequence: 60, attempt: ctx.attempt.number },
        () => runReactivationAgent(),
      )
      console.log("[PIPELINE_STAGE] Reactivation complete")
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error("PIPELINE FAILED at Reactivation:", error)
      throw new Error(`Pipeline failed at Reactivation: ${message}`)
    }

    console.log("[PIPELINE_STAGE] Pipeline complete", { reason: "all_stages_finished", leadsFound })
    await telemetry.completeWorkflowRun(workflowRunId, hadPartialFailure ? 'partial' : 'succeeded', {
      reason: 'all_stages_finished', leads_found: leadsFound, initial_email_mode: initialEmailMode,
    })
    return { leadsFound, initial_email_mode: initialEmailMode }
    } catch (error) {
      await telemetry.failWorkflowRun(workflowRunId, error)
      throw error
    } finally {
      await releaseLock(pipelineSupabase, DAILY_PIPELINE_LOCK_KEY, pipelineLockToken)
    }
    }

    return workflowRunId ? withWorkflowTrace({ workflowRunId }, executePipeline) : executePipeline()
  }
})
