import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/server'
import { previewCanaryLead, runCanaryInitialSend } from '@/lib/v2-canary-runtime'
import { assertCanarySingleRun, readCanaryConfiguration } from '@/lib/v2-canary-safety'
import type { Database } from '@/types/database'

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : undefined
}

async function main(): Promise<void> {
  const execute = process.argv.includes('--execute')
  const config = readCanaryConfiguration()
  const requestedLeadId = arg('--lead-id')
  const client = createServiceClient() as SupabaseClient<Database>

  if (execute) {
    if (!config.enabled) {
      throw new Error('V2_CANARY_ENABLED=false; enable only for an approved one-lead execution window.')
    }
    assertCanarySingleRun()
    const allowedLeadId = config.leadIds[0]
    const leadId = requestedLeadId ?? allowedLeadId
    if (leadId !== allowedLeadId) {
      throw new Error('--lead-id must equal the single allowlisted lead ID.')
    }
    const result = await runCanaryInitialSend({ leadId, correlationId: arg('--correlation-id') })
    console.log(JSON.stringify(result, null, 2))
    return
  }

  const leadId = requestedLeadId ?? (config.leadIds.length === 1 ? config.leadIds[0] : undefined)
  if (!leadId) {
    throw new Error('Preview requires --lead-id (or a single V2_CANARY_LEAD_IDS entry).')
  }
  const preview = await previewCanaryLead(client, leadId)
  console.log(JSON.stringify(preview, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
