import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { captureInitialEmailModeSnapshot } from '@/lib/initial-email-mode-operation'
import { runSequentialLeadsBulkOperation } from '@/lib/leads-bulk-progress'
import { leadsBulkRequestSchema } from '@/lib/leads-bulk-request'
import type { InitialEmailMode } from '@/lib/settingsDefaults'

async function main() {
  let savedMode: InitialEmailMode = 'template'
  let settingReads = 0
  const requestedModes: InitialEmailMode[] = []

  const resolveMode = () => captureInitialEmailModeSnapshot(async () => {
    settingReads++
    return Response.json({ initial_email_mode: savedMode })
  })

  async function runOperation(ids: string[]) {
    const mode = await resolveMode()
    return runSequentialLeadsBulkOperation({
      targetIds: ids,
      request: async (leadId) => {
        requestedModes.push(mode)
        if (leadId === 'first') savedMode = 'ai_personalised'
        return { lead_id: leadId, status: 'succeeded' }
      },
      failureOutcome: (leadId) => ({ lead_id: leadId, status: 'failed' }),
    })
  }

  await runOperation(['first', 'second', 'third'])
  assert.equal(settingReads, 1, 'the authoritative setting is resolved exactly once for an operation')
  assert.deepEqual(requestedModes, ['template', 'template', 'template'], 'every per-lead request receives the captured mode')

  requestedModes.length = 0
  await runOperation(['next-operation'])
  assert.equal(settingReads, 2, 'a subsequent operation resolves a fresh snapshot')
  assert.deepEqual(requestedModes, ['ai_personalised'], 'the subsequent operation sees the changed setting')

  for (const mode of ['template', 'ai_personalised']) {
    assert.equal(leadsBulkRequestSchema.safeParse({
      action: 'process_researched_leads',
      lead_ids: ['00000000-0000-4000-8000-000000000001'],
      initial_email_mode: mode,
    }).success, true, `${mode} is accepted as an explicit mode`)
  }
  for (const mode of ['ai-personalised', 'Template', '', null, 1]) {
    assert.equal(leadsBulkRequestSchema.safeParse({
      action: 'send_initial_emails',
      lead_ids: ['00000000-0000-4000-8000-000000000001'],
      initial_email_mode: mode,
    }).success, false, `${String(mode)} is rejected as an invalid explicit mode`)
  }

  const route = readFileSync(resolve(process.cwd(), 'src/app/api/leads/bulk/route.ts'), 'utf8')
  assert.match(route, /suppliedInitialEmailMode\s*\?\?\s*await readInitialEmailMode\(supabase\)/, 'valid explicit snapshots bypass the per-request setting lookup while legacy callers retain the lookup')

  const table = readFileSync(resolve(process.cwd(), 'src/components/leads/LeadsTable.tsx'), 'utf8')
  const snapshotIndex = table.indexOf('await captureInitialEmailModeSnapshot()')
  const loopIndex = table.indexOf('runSequentialLeadsBulkOperation({', snapshotIndex)
  const requestModeIndex = table.indexOf('initial_email_mode: initialEmailMode', loopIndex)
  assert.ok(snapshotIndex !== -1 && loopIndex > snapshotIndex, 'the UI captures mode before the per-lead loop')
  assert.ok(requestModeIndex > loopIndex, 'the UI includes that same snapshot in every per-lead request')
  const snapshotFailureIndex = table.indexOf('Operation did not start:', snapshotIndex)
  const snapshotFailureResultIndex = table.indexOf('setBulkResult({ progress, outcomes })', snapshotFailureIndex)
  assert.ok(snapshotFailureIndex > snapshotIndex && snapshotFailureResultIndex > snapshotFailureIndex, 'snapshot failures are surfaced in the bulk result without starting per-lead requests')

  console.log('Bulk Initial Email mode snapshot checks passed')
}

main().catch((error) => { console.error(error); process.exit(1) })
