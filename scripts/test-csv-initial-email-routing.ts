import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { initialEmailPolicyForCsvImport, loadInitialEmailModeSnapshots, saveInitialEmailModeSnapshot } from '@/lib/initial-email-mode-snapshot'

type Row = Record<string, any>
class ActivityQuery {
  private operation = 'select'
  private values?: Row
  private filters: Array<(row: Row) => boolean> = []
  constructor(private rows: Row[]) {}
  select() { return this }
  insert(values: Row) { this.operation = 'insert'; this.values = values; return this }
  eq(key: string, value: unknown) { this.filters.push((row) => row[key] === value); return this }
  in(key: string, values: unknown[]) { this.filters.push((row) => values.includes(row[key])); return this }
  order() { return this }
  then(resolve: (value: unknown) => unknown) {
    if (this.operation === 'insert') this.rows.push({ ...this.values, created_at: new Date().toISOString() })
    const data = this.rows.filter((row) => this.filters.every((filter) => filter(row)))
    return Promise.resolve(resolve({ data, error: null }))
  }
}

async function main() {
  assert.deepEqual(initialEmailPolicyForCsvImport('template'), { mode: 'template', action: 'generate_now' })
  assert.deepEqual(initialEmailPolicyForCsvImport('ai_personalised'), { mode: 'ai_personalised', action: 'defer_to_writer', snapshotSource: 'csv_import' })

  const rows: Row[] = []
  const supabase = { from: (table: string) => { assert.equal(table, 'activity_log'); return new ActivityQuery(rows) } } as never
  assert.deepEqual(await saveInitialEmailModeSnapshot(supabase, 'lead-ai', 'ai_personalised', 'csv_import'), { ok: true })
  const snapshots = await loadInitialEmailModeSnapshots(supabase, ['lead-ai', 'ordinary-lead'])
  assert.equal(snapshots.get('lead-ai'), 'ai_personalised', 'captured import mode reaches the eventual Writer lookup')
  assert.equal(snapshots.has('ordinary-lead'), false, 'ordinary leads remain on the Writer batch mode')

  const root = process.cwd()
  const importer = readFileSync(resolve(root, 'src/app/api/leads/import/route.ts'), 'utf8')
  const creator = readFileSync(resolve(root, 'src/lib/create-lead.ts'), 'utf8')
  const writer = readFileSync(resolve(root, 'agents/writer.ts'), 'utf8')
  const router = readFileSync(resolve(root, 'src/lib/initial-email-router.ts'), 'utf8')

  const snapshotRead = importer.indexOf('const initialEmailMode = await readInitialEmailMode(supabase)')
  const loop = importer.indexOf('for (const row of rows)')
  assert.ok(snapshotRead >= 0 && snapshotRead < loop, 'CSV captures one mode before processing any row')
  assert.match(importer, /initialEmailPolicyForCsvImport\(initialEmailMode\)/)
  assert.doesNotMatch(importer, /writeOutreachEmail|@\/ai\/workflows|aiRegistry/, 'CSV HTTP route has no AI import or call')
  assert.match(creator, /if \(initialEmail\.action === 'defer_to_writer'\)[\s\S]*saveInitialEmailModeSnapshot[\s\S]*return \{ ok: true/, 'AI CSV creation stages a snapshot and returns before generation')
  assert.ok(creator.indexOf("if (initialEmail.action === 'defer_to_writer')") < creator.indexOf('const generated = await routeInitialEmail'), 'deferred CSV path cannot reach synchronous routing')
  assert.match(writer, /loadInitialEmailModeSnapshots[\s\S]*importedModeSnapshots\.get\(lead\.id\) \?\? mode[\s\S]*writeOneLead\(supabase, lead, dedupeIndex, leadMode\)/, 'Writer consumes each imported lead snapshot instead of rereading settings')
  assert.match(router, /if \(mode === 'template'\)[\s\S]*generateInitialEmailFromTemplate[\s\S]*const writer = aiWriter \?\? \(await import\('@\/ai\/workflows'\)\)/, 'Template branch completes before the lazy AI import')
  assert.match(importer, /if \(result\.ok\) \{\s*imported\+\+[\s\S]*result\.generationError[\s\S]*continue/, 'a Template row failure preserves the imported lead, reports the row, and continues')
  assert.match(importer, /try \{\s*result = await createLead[\s\S]*catch \(error\)[\s\S]*failed\.push[\s\S]*continue/, 'an unexpected per-row failure is reported without stopping later CSV rows')
  assert.match(importer, /if \(result\.status === 409\) \{\s*duplicates\+\+\s*continue/, 'duplicate accounting remains unchanged')
  assert.match(importer, /Invalid email address/)
  assert.match(importer, /Unknown category/)

  const dailyPipeline = readFileSync(resolve(root, 'trigger/daily-pipeline.ts'), 'utf8')
  const modeRead = dailyPipeline.indexOf('const initialEmailMode = await readInitialEmailMode')
  assert.ok(modeRead >= 0 && modeRead < dailyPipeline.indexOf('runResearcherAgent(initialEmailMode)'), 'automatic batches capture mode once before Researcher')
  assert.ok(modeRead < dailyPipeline.indexOf('runWriterAgent(initialEmailMode)'), 'the same automatic batch snapshot reaches Writer')

  const manualRoute = readFileSync(resolve(root, 'src/app/api/leads/route.ts'), 'utf8')
  assert.ok(manualRoute.indexOf('const initialEmailMode = await readInitialEmailMode') < manualRoute.indexOf('await createLead'), 'Manual Add captures its request mode before lead creation')

  const regenerationRoute = readFileSync(resolve(root, 'src/app/api/leads/regenerate-emails/route.ts'), 'utf8')
  assert.match(regenerationRoute, /mode: z\.enum\(INITIAL_EMAIL_MODES\)/, 'regeneration accepts the mode captured by its confirmation')
  assert.match(regenerationRoute, /const mode = parsed\.data\.mode/, 'regeneration uses the confirmed snapshot for the complete batch')
  assert.match(regenerationRoute, /for \(const id[\s\S]*try \{[\s\S]*routeInitialEmail[\s\S]*catch \(error\)/, 'regeneration continues after an individual thrown generation failure')

  console.log('CSV Initial Email routing and mode snapshot checks passed')
}

main().catch((error) => { console.error(error); process.exit(1) })
