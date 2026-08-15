import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { routeInitialEmail, type InitialEmailLead } from '@/lib/initial-email-router'
import { emailBodyToHtml } from '@/lib/utils'
import { OUTREACH_SIGNATURE_TEXT } from '@/lib/outreach-signature'

type Row = Record<string, any>
type Failure = { table: string; operation: string; message: string; code?: string }

class MemoryDb {
  tables: Record<string, Row[]>
  failures: Failure[] = []
  constructor(seed: Record<string, Row[]> = {}) {
    this.tables = Object.fromEntries(Object.entries(seed).map(([key, rows]) => [key, rows.map((row) => ({ ...row }))]))
  }
  from(table: string) { return new Query(this, table) }
  fail(table: string, operation: string, message: string, code = 'TEST') { this.failures.push({ table, operation, message, code }) }
  takeFailure(table: string, operation: string) {
    const index = this.failures.findIndex((item) => item.table === table && item.operation === operation)
    if (index < 0) return null
    const [failure] = this.failures.splice(index, 1)
    return { message: failure.message, code: failure.code }
  }
}

class Query {
  private operation = 'select'
  private values: Row | Row[] | undefined
  private filters: Array<(row: Row) => boolean> = []
  constructor(private db: MemoryDb, private table: string) {}
  select() { return this }
  eq(key: string, value: unknown) { this.filters.push((row) => row[key] === value); return this }
  in(key: string, values: unknown[]) { this.filters.push((row) => values.includes(row[key])); return this }
  lt(key: string, value: unknown) { this.filters.push((row) => row[key] < (value as any)); return this }
  limit() { return this }
  order() { return this }
  insert(values: Row | Row[]) { this.operation = 'insert'; this.values = values; return this }
  update(values: Row) { this.operation = 'update'; this.values = values; return this }
  delete() { this.operation = 'delete'; return this }
  private matching() { return (this.db.tables[this.table] ?? []).filter((row) => this.filters.every((filter) => filter(row))) }
  private execute() {
    const failure = this.db.takeFailure(this.table, this.operation)
    if (failure) return { data: null, error: failure }
    const table = (this.db.tables[this.table] ??= [])
    if (this.operation === 'insert') {
      const input = Array.isArray(this.values) ? this.values : [this.values!]
      if (this.table === 'distributed_locks' && input.some((row) => table.some((old) => old.lock_key === row.lock_key))) {
        return { data: null, error: { message: 'duplicate lock', code: '23505' } }
      }
      if (this.table === 'emails' && input.some((row) => table.some((old) => old.lead_id === row.lead_id && old.type === row.type && old.status === 'pending_send' && row.status === 'pending_send'))) {
        return { data: null, error: { message: 'duplicate pending email', code: '23505' } }
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
  async maybeSingle() { const result = this.execute(); return { data: Array.isArray(result.data) ? result.data[0] ?? null : result.data, error: result.error } }
  async single() { const result = this.execute(); const data = Array.isArray(result.data) ? result.data[0] ?? null : result.data; return { data, error: result.error ?? (data ? null : { message: 'not found' }) } }
  then(resolve: (value: unknown) => unknown) { return Promise.resolve(resolve(this.execute())) }
}

const lead: InitialEmailLead = { id: 'lead-1', business_name: 'Harbour Escape', category_id: 'cat-1', category_name: 'Escape Rooms', suburb: null, city: 'Sydney', website: 'https://example.com', description: null, services: null, content_type: 'remote' }
const template = { category_id: 'cat-1', template_type: 'initial_pitch', subject_template: 'Hello {{business_name}}', body_template: 'Hey {{business_name}}, {{category_name}} in {{city}}' }
const signoffLinks = [
  'mailto:hello@aussieventure.com',
  'https://aussieventure.com',
  'https://instagram.com/aussie.venture',
  'https://tiktok.com/@aussie.venture',
  'https://facebook.com/AussieVenture',
  'https://facebook.com/Sydneyventure',
]
const seed = (extra: Record<string, Row[]> = {}) => new MemoryDb({
  categories: [{ id: 'cat-1', name: 'Escape Rooms' }], category_email_templates: [template],
  distributed_locks: [], emails: [], leads: [{ id: 'lead-1', status: 'researched' }], ...extra,
})

async function main() {
  let aiCalls = 0
  const templateDb = seed()
  const created = await routeInitialEmail(templateDb as never, lead, 'template', { aiWriter: async () => { aiCalls++; throw new Error('AI must not run') } })
  assert.equal(created.ok && created.outcome, 'created')
  assert.equal(aiCalls, 0, 'Template persistence makes no AI call')
  assert.deepEqual(templateDb.tables.emails.map(({ type, status, generation_source }) => ({ type, status, generation_source })), [{ type: 'initial_pitch', status: 'pending_send', generation_source: 'template' }])
  assert.equal(templateDb.tables.leads[0].status, 'email_ready')
  const templateEmail = templateDb.tables.emails[0]
  assert.equal(templateDb.tables.category_email_templates[0].body_template, template.body_template, 'the stored category template remains core message text only')
  assert.ok(templateEmail.body_html.includes('data-outreach-signature="aussie-venture"'), 'Template HTML appends the shared professional signature')
  for (const link of signoffLinks) assert.ok(templateEmail.body_html.includes(link), `Template HTML contains ${link}`)
  for (const link of signoffLinks.map((link) => link.replace('mailto:', ''))) assert.ok(templateEmail.body_text.includes(link), `Template text contains ${link}`)
  assert.doesNotMatch(templateEmail.body_text, /<[^>]+>/, 'Template body_text contains no HTML tags')
  assert.equal(templateEmail.body_text.match(/hello@aussieventure\.com/g)?.length, 1, 'plain-text signature appears exactly once')
  assert.equal(templateEmail.body_html.match(/mailto:hello@aussieventure\.com/g)?.length, 1, 'HTML signature appears exactly once')

  const repeated = await routeInitialEmail(templateDb as never, lead, 'ai_personalised', { aiWriter: async () => { aiCalls++; return { subject: 'wrong', body: 'wrong' } } })
  assert.equal(repeated.ok && repeated.outcome, 'existing')
  assert.equal(aiCalls, 0, 'normal repeated generation does not call AI')
  assert.equal(templateDb.tables.emails.length, 1, 'normal repeated generation does not overwrite or duplicate')

  const aiDb = seed()
  let aiInput: unknown
  const aiCreated = await routeInitialEmail(aiDb as never, lead, 'ai_personalised', { aiWriter: async (input) => { aiCalls++; aiInput = input; return { subject: 'AI subject', body: 'AI body' } } })
  assert.equal(aiCreated.ok && aiCreated.generationSource, 'ai')
  assert.equal(aiCalls, 1, 'AI Personalised invokes the existing Writer exactly once')
  assert.deepEqual(aiInput, {
    business_name: lead.business_name, category: lead.category_name, suburb: '', city: lead.city,
    website: lead.website, description: '', services: '', content_type: lead.content_type,
  }, 'router passes the existing writer inputs through without alteration')
  assert.equal(aiDb.tables.emails[0].subject, 'AI subject')
  assert.equal(aiDb.tables.emails[0].body_text, `AI body\n\n${OUTREACH_SIGNATURE_TEXT}`)
  assert.equal(aiDb.tables.emails[0].body_html, emailBodyToHtml('AI body'), 'AI Personalised HTML remains on the existing formatter path')
  assert.equal(aiDb.tables.emails[0].generation_source, 'ai')

  let aiRegenerationCalls = 0
  const aiRegeneration = await routeInitialEmail(aiDb as never, lead, 'ai_personalised', {
    operation: 'regenerate', pendingEmailId: aiDb.tables.emails[0].id as string,
    aiWriter: async () => { aiRegenerationCalls++; return { subject: 'Regenerated AI subject', body: 'Regenerated AI body' } },
  })
  assert.equal(aiRegeneration.ok && aiRegeneration.outcome, 'regenerated')
  assert.equal(aiRegenerationCalls, 1, 'AI regeneration calls the existing Writer exactly once')
  assert.equal(aiDb.tables.emails[0].subject, 'Regenerated AI subject')
  assert.equal(aiDb.tables.emails[0].generation_source, 'ai')

  const lockedDb = seed({ distributed_locks: [{ lock_key: 'initial-email-generation:lead-1', locked_at: new Date().toISOString(), owner_token: 'other' }] })
  const locked = await routeInitialEmail(lockedDb as never, lead, 'template')
  assert.equal(!locked.ok && locked.error.code, 'generation_in_progress')
  assert.equal(lockedDb.tables.emails.length, 0, 'lock conflict creates no duplicate')

  const missingDb = seed({ category_email_templates: [] })
  const missing = await routeInitialEmail(missingDb as never, lead, 'template')
  assert.equal(!missing.ok && missing.error.code, 'missing_template')
  assert.equal(missingDb.tables.emails.length, 0)
  assert.equal(missingDb.tables.leads[0].status, 'researched')

  const templateFailures: Array<[string, ReturnType<typeof seed>, InitialEmailLead]> = [
    ['missing_category_id', seed(), { ...lead, category_id: null }],
    ['category_not_found', seed({ categories: [] }), lead],
    ['empty_subject', seed({ category_email_templates: [{ ...template, subject_template: ' ' }] }), lead],
    ['empty_body', seed({ category_email_templates: [{ ...template, body_template: ' ' }] }), lead],
    ['invalid_template', seed({ category_email_templates: [{ ...template, body_template: '{{unsupported}}' }] }), lead],
    ['missing_lead_value', seed({ category_email_templates: [{ ...template, body_template: '{{website}}' }] }), { ...lead, website: null }],
  ]
  for (const [code, db, input] of templateFailures) {
    const result = await routeInitialEmail(db as never, input, 'template', { aiWriter: async () => { throw new Error('AI must not be a Template fallback') } })
    assert.equal(!result.ok && result.error.code, code, `${code} is reported without AI fallback`)
    assert.equal(db.tables.emails.length, 0, `${code} saves no blank, broken, or unresolved email`)
    assert.equal(db.tables.leads[0].status, 'researched', `${code} does not move the lead to email_ready`)
  }

  const readFailureDb = seed()
  readFailureDb.fail('category_email_templates', 'select', 'template read failed')
  const readFailure = await routeInitialEmail(readFailureDb as never, lead, 'template')
  assert.equal(!readFailure.ok && readFailure.error.code, 'template_load_failed')
  assert.equal(readFailureDb.tables.emails.length, 0)

  const writeFailureDb = seed()
  writeFailureDb.fail('emails', 'insert', 'email write failed')
  const writeFailure = await routeInitialEmail(writeFailureDb as never, lead, 'template')
  assert.equal(!writeFailure.ok && writeFailure.error.code, 'database_save_conflict')
  assert.equal(writeFailureDb.tables.emails.length, 0)
  assert.equal(writeFailureDb.tables.leads[0].status, 'researched')

  const uniqueConflictDb = seed({ emails: [{ id: 'concurrent', lead_id: 'other', type: 'follow_up_1', status: 'sent' }] })
  uniqueConflictDb.fail('emails', 'insert', 'duplicate pending email', '23505')
  const uniqueConflict = await routeInitialEmail(uniqueConflictDb as never, lead, 'template')
  assert.equal(uniqueConflict.ok && uniqueConflict.outcome, 'existing', 'a concurrent unique conflict resolves idempotently')
  assert.equal(uniqueConflictDb.tables.leads[0].status, 'researched', 'a conflict does not perform an incorrect status transition')

  const transitionDb = seed()
  transitionDb.fail('leads', 'update', 'lead transition failed')
  const transition = await routeInitialEmail(transitionDb as never, lead, 'template')
  assert.equal(!transition.ok && transition.error.code, 'lead_transition_failed')
  assert.equal(transitionDb.tables.emails.length, 0, 'transition failure removes only the inserted draft')

  const regenerationDb = seed({ emails: [
    { id: 'target', lead_id: 'lead-1', type: 'initial_pitch', status: 'pending_send', subject: 'old', body_text: 'old', generation_source: 'ai' },
    { id: 'sent', lead_id: 'lead-1', type: 'initial_pitch', status: 'sent', subject: 'sent', body_text: 'sent', generation_source: 'ai' },
    { id: 'sync', lead_id: 'lead-1', type: 'initial_pitch', status: 'email_sync_failed', subject: 'sync', body_text: 'sync', generation_source: 'ai' },
    { id: 'follow', lead_id: 'lead-1', type: 'follow_up_1', status: 'pending_send', subject: 'follow', body_text: 'follow' },
    { id: 'react', lead_id: 'lead-1', type: 'reactivation', status: 'pending_send', subject: 'react', body_text: 'react' },
  ] })
  const regenerated = await routeInitialEmail(regenerationDb as never, lead, 'template', { operation: 'regenerate', pendingEmailId: 'target' })
  assert.equal(regenerated.ok && regenerated.outcome, 'regenerated')
  assert.equal(regenerationDb.tables.emails.find((row) => row.id === 'target')?.generation_source, 'template')
  assert.deepEqual(regenerationDb.tables.emails.filter((row) => row.id !== 'target'), [
    { id: 'sent', lead_id: 'lead-1', type: 'initial_pitch', status: 'sent', subject: 'sent', body_text: 'sent', generation_source: 'ai' },
    { id: 'sync', lead_id: 'lead-1', type: 'initial_pitch', status: 'email_sync_failed', subject: 'sync', body_text: 'sync', generation_source: 'ai' },
    { id: 'follow', lead_id: 'lead-1', type: 'follow_up_1', status: 'pending_send', subject: 'follow', body_text: 'follow' },
    { id: 'react', lead_id: 'lead-1', type: 'reactivation', status: 'pending_send', subject: 'react', body_text: 'react' },
  ], 'sent Initial Emails, Follow-ups and Reactivation remain unchanged')

  for (const id of ['sent', 'sync', 'follow', 'react']) {
    const before = structuredClone(regenerationDb.tables.emails)
    const result = await routeInitialEmail(regenerationDb as never, lead, 'template', { operation: 'regenerate', pendingEmailId: id })
    assert.equal(!result.ok && result.error.code, 'database_save_conflict', `${id} is ineligible for regeneration`)
    assert.deepEqual(regenerationDb.tables.emails, before, `${id} remains unchanged`)
  }

  const failedRegenerationDb = seed({ emails: [{ id: 'target', lead_id: 'lead-1', type: 'initial_pitch', status: 'pending_send', subject: 'old', body_text: 'old', generation_source: 'ai' }] })
  failedRegenerationDb.fail('emails', 'update', 'save failed')
  const failedRegeneration = await routeInitialEmail(failedRegenerationDb as never, lead, 'template', { operation: 'regenerate', pendingEmailId: 'target' })
  assert.equal(!failedRegeneration.ok && failedRegeneration.error.code, 'database_save_conflict')
  assert.deepEqual(failedRegenerationDb.tables.emails[0], { id: 'target', lead_id: 'lead-1', type: 'initial_pitch', status: 'pending_send', subject: 'old', body_text: 'old', generation_source: 'ai' }, 'failed regeneration preserves subject, body and source')

  const retryRegeneration = await routeInitialEmail(failedRegenerationDb as never, lead, 'template', { operation: 'regenerate', pendingEmailId: 'target' })
  assert.equal(retryRegeneration.ok && retryRegeneration.outcome, 'regenerated', 'regeneration can be retried after an individual save failure')
  assert.equal(failedRegenerationDb.tables.emails[0].generation_source, 'template')

  const missingTemplateRegenerationDb = seed({
    category_email_templates: [],
    emails: [{ id: 'target', lead_id: 'lead-1', type: 'initial_pitch', status: 'pending_send', subject: 'protected', body_text: 'protected body', generation_source: 'ai' }],
  })
  const missingTemplateRegeneration = await routeInitialEmail(missingTemplateRegenerationDb as never, lead, 'template', { operation: 'regenerate', pendingEmailId: 'target' })
  assert.equal(!missingTemplateRegeneration.ok && missingTemplateRegeneration.error.code, 'missing_template')
  assert.equal(missingTemplateRegenerationDb.tables.emails[0].subject, 'protected', 'failed Template rendering preserves the original pending email')
  assert.equal(missingTemplateRegenerationDb.tables.emails[0].generation_source, 'ai')

  const templateChangeDb = seed({ emails: [{ id: 'target', lead_id: 'lead-1', type: 'initial_pitch', status: 'pending_send', subject: 'old subject', body_text: 'old body', generation_source: 'template' }] })
  templateChangeDb.tables.category_email_templates[0].subject_template = 'Changed {{business_name}}'
  const withoutExplicitRegeneration = await routeInitialEmail(templateChangeDb as never, lead, 'template')
  assert.equal(withoutExplicitRegeneration.ok && withoutExplicitRegeneration.outcome, 'existing')
  assert.equal(templateChangeDb.tables.emails[0].subject, 'old subject', 'changing a template does not alter an existing draft')
  assert.equal(templateChangeDb.tables.emails[0].body_text, 'old body', 'an existing draft does not receive the signature without regeneration')
  const afterExplicitRegeneration = await routeInitialEmail(templateChangeDb as never, lead, 'template', { operation: 'regenerate', pendingEmailId: 'target' })
  assert.equal(afterExplicitRegeneration.ok && afterExplicitRegeneration.outcome, 'regenerated')
  assert.equal(templateChangeDb.tables.emails[0].subject, 'Changed Harbour Escape', 'explicit regeneration applies the changed template')
  assert.equal(templateChangeDb.tables.emails[0].body_text.match(/hello@aussieventure\.com/g)?.length, 1, 'explicit regeneration adds the plain-text signature exactly once')
  assert.equal(templateChangeDb.tables.emails[0].body_html.match(/mailto:hello@aussieventure\.com/g)?.length, 1, 'explicit regeneration adds the HTML signature exactly once')

  const batchModes: string[] = []
  const batchResults = []
  for (const batchLead of [{ ...lead, id: 'bad', category_id: null }, { ...lead, id: 'good' }]) {
    const db = seed({ leads: [{ id: batchLead.id, status: 'researched' }] })
    batchModes.push('template')
    batchResults.push(await routeInitialEmail(db as never, batchLead, 'template'))
  }
  assert.equal(batchResults[0].ok, false)
  assert.equal(batchResults[1].ok, true, 'batch-style loop continues after one lead fails')
  assert.deepEqual(batchModes, ['template', 'template'], 'one captured mode is used throughout a batch')

  const routerSource = readFileSync(resolve(process.cwd(), 'src/lib/initial-email-router.ts'), 'utf8')
  assert.match(routerSource, /eq\('lead_id', lead\.id\)[\s\S]*eq\('type', 'initial_pitch'\)[\s\S]*eq\('status', 'pending_send'\)/, 'regeneration is fenced to the lead, Initial Email type and pending status')
  console.log('Initial Email router persistence and regeneration checks passed')
}

main().catch((error) => { console.error(error); process.exit(1) })
