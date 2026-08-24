import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createLeadDedupeIndex } from '@/lib/deduplication'
import { routeInitialEmail } from '@/lib/initial-email-router'
import { summarizeLeadsBulkOutcomes } from '@/lib/leads-bulk-progress'
import { processResearchedLead, type ResearchedLeadForInitialEmail } from '@/lib/process-researched-lead'

type Row = Record<string, any>

class MemoryDb {
  tables: Record<string, Row[]>

  constructor(leads: ResearchedLeadForInitialEmail[], templates: Row[]) {
    this.tables = {
      leads: leads.map((lead) => ({ ...lead })),
      categories: [
        { id: 'cat-1', name: 'Escape Rooms' },
        { id: 'cat-2', name: 'Missing Template Category' },
      ],
      category_email_templates: templates.map((template) => ({ ...template })),
      distributed_locks: [],
      emails: [],
      activity_log: [],
    }
  }

  from(table: string) { return new Query(this, table) }
}

class Query {
  private operation: 'select' | 'insert' | 'update' | 'delete' = 'select'
  private values: Row | Row[] | undefined
  private filters: Array<(row: Row) => boolean> = []

  constructor(private db: MemoryDb, private table: string) {}
  select() { return this }
  eq(key: string, value: unknown) { this.filters.push((row) => row[key] === value); return this }
  lt(key: string, value: unknown) { this.filters.push((row) => row[key] < (value as any)); return this }
  limit() { return this }
  insert(values: Row | Row[]) { this.operation = 'insert'; this.values = values; return this }
  update(values: Row) { this.operation = 'update'; this.values = values; return this }
  delete() { this.operation = 'delete'; return this }

  private matching() {
    return (this.db.tables[this.table] ?? []).filter((row) => this.filters.every((filter) => filter(row)))
  }

  private execute() {
    const table = (this.db.tables[this.table] ??= [])
    if (this.operation === 'insert') {
      const input = Array.isArray(this.values) ? this.values : [this.values!]
      if (this.table === 'distributed_locks' && input.some((row) => table.some((old) => old.lock_key === row.lock_key))) {
        return { data: null, error: { message: 'duplicate lock', code: '23505' } }
      }
      if (this.table === 'emails' && input.some((row) => table.some((old) => old.lead_id === row.lead_id && old.type === row.type && old.status === 'pending_send' && row.status === 'pending_send'))) {
        return { data: null, error: { message: 'duplicate Initial Email', code: '23505' } }
      }
      const inserted = input.map((row) => ({ id: row.id ?? `${this.table}-${table.length + 1}`, ...row }))
      table.push(...inserted)
      return { data: Array.isArray(this.values) ? inserted : inserted[0], error: null }
    }
    const rows = this.matching()
    if (this.operation === 'update') rows.forEach((row) => Object.assign(row, this.values))
    if (this.operation === 'delete') this.db.tables[this.table] = table.filter((row) => !rows.includes(row))
    return { data: rows, error: null }
  }

  async maybeSingle() {
    const result = this.execute()
    return { data: Array.isArray(result.data) ? result.data[0] ?? null : result.data, error: result.error }
  }

  async single() {
    const result = this.execute()
    const data = Array.isArray(result.data) ? result.data[0] ?? null : result.data
    return { data, error: result.error ?? (data ? null : { message: 'not found', code: 'TEST' }) }
  }

  then(resolvePromise: (value: unknown) => unknown) { return Promise.resolve(resolvePromise(this.execute())) }
}

const template = {
  category_id: 'cat-1',
  template_type: 'initial_pitch',
  subject_template: 'Hello {{business_name}}',
  body_template: 'A deterministic email for {{business_name}} in {{city}}.',
}

function lead(id: string, categoryId = 'cat-1'): ResearchedLeadForInitialEmail {
  return {
    id,
    business_name: `Lead ${id}`,
    category_id: categoryId,
    category_name: categoryId === 'cat-1' ? 'Escape Rooms' : 'Missing Template Category',
    suburb: 'CBD',
    city: 'Sydney',
    website: `https://${id}.example`,
    description: 'An escape room business',
    services: 'Escape rooms',
    email: `${id}@gmail.com`,
    instagram_handle: null,
    content_type: 'remote',
    status: 'researched',
  }
}

async function main() {
  // A. Two selected researched leads use one Template snapshot and the shared
  // Writer/router persistence path. The deterministic branch has no AI hook.
  const templateLeads = [lead('template-one'), lead('template-two')]
  const templateDb = new MemoryDb(templateLeads, [template])
  const templateOutcomes = []
  const templateModeSnapshot = 'template' as const
  const templateDedupe = createLeadDedupeIndex([])
  for (const item of templateLeads) {
    templateOutcomes.push(await processResearchedLead(templateDb as never, item, templateDedupe, templateModeSnapshot))
  }
  assert.deepEqual(templateOutcomes.map((outcome) => outcome.status), ['succeeded', 'succeeded'])
  assert.equal(templateDb.tables.emails.length, 2)
  assert.deepEqual(templateDb.tables.emails.map((email) => email.generation_source), ['template', 'template'])
  assert.deepEqual(templateDb.tables.leads.map((item) => item.status), ['email_ready', 'email_ready'])

  // B. AI Personalised is passed to the existing router path and persists the
  // same pending/reviewable Initial Email shape before the lead is transitioned.
  const aiLead = lead('ai-lead')
  const aiDb = new MemoryDb([aiLead], [template])
  let aiCalls = 0
  const aiOutcome = await processResearchedLead(
    aiDb as never,
    aiLead,
    createLeadDedupeIndex([]),
    'ai_personalised',
    async (db, item, dedupe, mode) => {
      assert.equal(mode, 'ai_personalised')
      assert.ok(dedupe)
      const generated = await routeInitialEmail(db, item, mode, {
        aiWriter: async () => {
          aiCalls++
          return { subject: 'AI subject', body: 'AI body' }
        },
      })
      if (!generated.ok) return { success: false, error: generated.error.reason }
      return { success: true, channel: 'email', outcome: generated.outcome === 'existing' ? 'existing' : 'created', generationSource: generated.generationSource }
    },
  )
  assert.equal(aiOutcome.status, 'succeeded')
  assert.equal(aiCalls, 1)
  assert.equal(aiDb.tables.emails[0].generation_source, 'ai')
  assert.equal(aiDb.tables.emails[0].status, 'pending_send')
  assert.equal(aiDb.tables.leads[0].status, 'email_ready')

  // C. A missing Template is isolated to that lead; the valid lead succeeds
  // and the shared summary reports the mixed result.
  const goodLead = lead('good')
  const missingTemplateLead = lead('missing-template', 'cat-2')
  const mixedDb = new MemoryDb([goodLead, missingTemplateLead], [template])
  const mixedDedupe = createLeadDedupeIndex([])
  const mixedOutcomes = []
  for (const item of [goodLead, missingTemplateLead]) {
    mixedOutcomes.push(await processResearchedLead(mixedDb as never, item, mixedDedupe, 'template'))
  }
  assert.deepEqual(summarizeLeadsBulkOutcomes(2, mixedOutcomes), {
    total: 2, processed: 2, succeeded: 1, skipped: 0, failed: 1,
  })
  assert.equal(mixedDb.tables.leads.find((item) => item.id === 'good')?.status, 'email_ready')
  assert.equal(mixedDb.tables.leads.find((item) => item.id === 'missing-template')?.status, 'researched')
  assert.match(mixedOutcomes[1].reason ?? '', /missing_template/)

  // D. Existing pending Initial Emails remain idempotent and do not transition
  // an inconsistent researched row or create another email.
  const duplicateLead = lead('already-has-email')
  const duplicateDb = new MemoryDb([duplicateLead], [template])
  duplicateDb.tables.emails.push({
    id: 'existing-email', lead_id: duplicateLead.id, type: 'initial_pitch', status: 'pending_send',
    subject: 'Existing', body_text: 'Existing', body_html: '<p>Existing</p>', generation_source: 'template',
  })
  const duplicateOutcome = await processResearchedLead(duplicateDb as never, duplicateLead, createLeadDedupeIndex([]), 'template')
  assert.equal(duplicateOutcome.status, 'skipped')
  assert.equal(duplicateDb.tables.emails.length, 1)
  assert.equal(duplicateDb.tables.leads[0].status, 'researched')

  // E. UI/API wiring keeps this action researched-only.
  const tableSource = readFileSync(resolve(process.cwd(), 'src/components/leads/LeadsTable.tsx'), 'utf8')
  assert.match(tableSource, /processEligibleLeads\s*=\s*leads\.filter\(l => l\.status === 'researched'\)/)
  assert.match(tableSource, /selectedResearchedLeads\.length > 0[\s\S]*Process to Email Ready/)
  assert.match(tableSource, /isSelectable\s*=\s*isEmailReady \|\| isNew \|\| isResearched/)
  assert.doesNotMatch(tableSource, /processEligibleLeads\s*=\s*leads\.filter\(l => l\.status !==/)

  const routeSource = readFileSync(resolve(process.cwd(), 'src/app/api/leads/bulk/route.ts'), 'utf8')
  assert.match(routeSource, /action === 'process_researched_leads'/)
  assert.match(routeSource, /processResearchedLead\(supabase, lead, dedupeIndex, initialEmailMode!\)/)
  const helperSource = readFileSync(resolve(process.cwd(), 'src/lib/process-researched-lead.ts'), 'utf8')
  assert.match(helperSource, /writer: InitialEmailWriter = writeOneLead/)

  console.log('Bulk researched-to-Email-Ready checks passed')
}

main().catch((error) => { console.error(error); process.exit(1) })
