import assert from 'node:assert/strict'
import {
  researchOneLead,
  researchPurposeForInitialEmailMode,
  type ResearchPurpose,
} from '@/lib/research-lead'
import { routeInitialEmail } from '@/lib/initial-email-router'
import { writeOneLead } from '@/lib/write-lead'
import { createLeadDedupeIndex } from '@/lib/deduplication'

type Row = Record<string, any>

class MemoryDb {
  tables: Record<string, Row[]>

  constructor(leads: Row[]) {
    this.tables = {
      leads: leads.map((lead) => ({ ...lead })),
      activity_log: [],
      categories: [{ id: 'cat-1', name: 'Escape Rooms' }],
      category_email_templates: [{
        category_id: 'cat-1',
        template_type: 'initial_pitch',
        subject_template: 'Hello {{business_name}}',
        body_template: 'A deterministic email for {{business_name}} in {{city}}.',
      }],
      distributed_locks: [],
      emails: [],
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

  then(resolve: (value: unknown) => unknown) { return Promise.resolve(resolve(this.execute())) }
}

const baseLead = {
  id: 'lead-1',
  business_name: 'Harbour Escape',
  category_id: 'cat-1' as string | null,
  category_name: 'Escape Rooms',
  suburb: null,
  city: 'Sydney',
  website: 'https://example.com',
  email: null as string | null,
  description: null,
  services: null,
  instagram_handle: null,
  content_type: 'remote',
  halal_confidence_score: null,
  google_reviews_count: 20,
  status: 'new',
}

type Counters = {
  writer: number
  personalisation: number
  initialEmailProvider: number
  contactFallback: number
  websiteDiscovery: number
}

function counters(): Counters {
  return { writer: 0, personalisation: 0, initialEmailProvider: 0, contactFallback: 0, websiteDiscovery: 0 }
}

function throwingTemplateDependencies(calls: Counters) {
  const initialEmailProvider = async (): Promise<{ subject: string; body: string }> => {
    calls.initialEmailProvider++
    throw new Error('Initial Email AI registry/provider must not run in Template mode')
  }
  return {
    aiWriter: async () => {
      calls.writer++
      return initialEmailProvider()
    },
    extractWebsiteData: async () => {
      calls.personalisation++
      throw new Error('AI personalisation enrichment must not run in Template mode')
    },
  }
}

async function researchThenGenerate(
  db: MemoryDb,
  lead: typeof baseLead,
  purpose: ResearchPurpose,
  mode: 'template' | 'ai_personalised',
  dependencies: Parameters<typeof researchOneLead>[3],
  aiWriter: NonNullable<NonNullable<Parameters<typeof routeInitialEmail>[3]>['aiWriter']>,
) {
  const research = await researchOneLead(db as never, lead, purpose, dependencies)
  if (!research.success) return { research, generated: null, missingEmail: false }
  const enrichedLead = { ...lead, ...research.updatedFields }
  if (!enrichedLead.email) return { research, generated: null, missingEmail: true }
  const generated = await routeInitialEmail(db as never, enrichedLead, mode, { aiWriter })
  return { research, generated, missingEmail: false }
}

async function main() {
  assert.equal(researchPurposeForInitialEmailMode('template'), 'contact_discovery_only')
  assert.equal(researchPurposeForInitialEmailMode('ai_personalised'), 'full_personalisation')

  // Case A: an existing business email bypasses contact discovery and every
  // Initial Email AI boundary, while deterministic template routing succeeds.
  {
    const calls = counters()
    // Finder persists category_name but historically leaves category_id null.
    const lead = { ...baseLead, category_id: null, email: 'existing@example.com' }
    const db = new MemoryDb([lead])
    const templateAi = throwingTemplateDependencies(calls)
    const result = await researchThenGenerate(db, lead, 'contact_discovery_only', 'template', {
      fetchRawHtml: async () => { calls.websiteDiscovery++; throw new Error('contact discovery was unnecessary') },
      extractMailtoEmail: () => { throw new Error('mailto discovery was unnecessary') },
      agenticEmailSearch: async () => { calls.contactFallback++; throw new Error('contact fallback was unnecessary') },
      extractWebsiteData: templateAi.extractWebsiteData,
    }, templateAi.aiWriter)
    assert.equal(result.generated?.ok && result.generated.generationSource, 'template')
    assert.deepEqual(calls, counters(), 'Case A makes no contact-discovery, personalisation, Writer, or Initial Email provider call')
    assert.equal(db.tables.emails[0].generation_source, 'template')
    assert.equal(db.tables.leads[0].status, 'email_ready')
  }

  // Case B: public website/mailto discovery wins before the contact fallback.
  {
    const calls = counters()
    const db = new MemoryDb([baseLead])
    const templateAi = throwingTemplateDependencies(calls)
    const result = await researchThenGenerate(db, baseLead, 'contact_discovery_only', 'template', {
      fetchRawHtml: async () => { calls.websiteDiscovery++; return '<a href="mailto:hello@example.com">Email us</a>' },
      extractMailtoEmail: () => 'hello@example.com',
      agenticEmailSearch: async () => { calls.contactFallback++; throw new Error('AI contact fallback must not run after mailto succeeds') },
      extractWebsiteData: templateAi.extractWebsiteData,
    }, templateAi.aiWriter)
    assert.equal(result.research.success && result.research.updatedFields.email, 'hello@example.com')
    assert.equal(result.generated?.ok && result.generated.generationSource, 'template')
    assert.equal(calls.websiteDiscovery, 1)
    assert.equal(calls.contactFallback, 0)
    assert.equal(calls.personalisation, 0)
    assert.equal(calls.writer, 0)
    assert.equal(calls.initialEmailProvider, 0)
  }

  // Case C: the established AI-assisted finder remains available solely to
  // obtain the missing business email; rendering stays deterministic.
  {
    const calls = counters()
    const db = new MemoryDb([baseLead])
    const templateAi = throwingTemplateDependencies(calls)
    const result = await researchThenGenerate(db, baseLead, 'contact_discovery_only', 'template', {
      fetchRawHtml: async () => { calls.websiteDiscovery++; return '<p>Contact form only</p>' },
      extractMailtoEmail: () => null,
      agenticEmailSearch: async () => {
        calls.contactFallback++
        return { email: 'fallback@example.com', method: 'agentic_contact_discovery', rounds: 2 }
      },
      extractWebsiteData: templateAi.extractWebsiteData,
    }, templateAi.aiWriter)
    assert.equal(result.research.success && result.research.updatedFields.email, 'fallback@example.com')
    assert.equal(result.generated?.ok && result.generated.generationSource, 'template')
    assert.equal(calls.contactFallback, 1)
    assert.equal(calls.personalisation, 0)
    assert.equal(calls.writer, 0)
    assert.equal(calls.initialEmailProvider, 0)
  }

  // Case D: a missing business email is a per-lead failure. No broken draft or
  // email_ready transition is created, and the next batch lead still succeeds.
  {
    const calls = counters()
    const missingLead = { ...baseLead, id: 'missing-email', business_name: 'Missing Email Co' }
    const goodLead = { ...baseLead, id: 'next-lead', business_name: 'Next Lead', category_id: null, email: 'next@example.com' }
    const db = new MemoryDb([missingLead, goodLead])
    const templateAi = throwingTemplateDependencies(calls)
    const outcomes: string[] = []
    const dedupeIndex = createLeadDedupeIndex([])
    for (const lead of [missingLead, goodLead]) {
      const research = await researchOneLead(db as never, lead, 'contact_discovery_only', {
        fetchRawHtml: async () => '<p>No public email</p>',
        extractMailtoEmail: () => null,
        agenticEmailSearch: async () => {
          calls.contactFallback++
          return { email: null, method: 'agentic_contact_discovery', rounds: 2 }
        },
        extractWebsiteData: templateAi.extractWebsiteData,
      })
      assert.equal(research.success, true)
      if (!research.success) continue
      const written = await writeOneLead(db as never, { ...lead, ...research.updatedFields }, dedupeIndex, 'template')
      assert.equal(written.success, true)
      if (written.success) outcomes.push(written.channel)
    }
    assert.deepEqual(outcomes, ['dead', 'email'], 'the missing-email lead fails independently and the batch continues')
    assert.equal(db.tables.emails.some((row) => row.lead_id === 'missing-email'), false)
    assert.equal(db.tables.leads.find((row) => row.id === 'missing-email')?.status, 'dead')
    const missingEmailFailure = db.tables.activity_log.find((row) => row.event_type === 'lead_dead')
    assert.equal(missingEmailFailure?.lead_id, 'missing-email', 'the failure identifies the affected lead')
    assert.match(missingEmailFailure?.description ?? '', /No email.*Missing Email Co/, 'the failure identifies the missing business email and business')
    assert.equal(db.tables.emails.find((row) => row.lead_id === 'next-lead')?.generation_source, 'template', 'the next batch lead continues')
    assert.equal(db.tables.leads.find((row) => row.id === 'next-lead')?.status, 'email_ready')
    assert.equal(calls.personalisation, 0)
    assert.equal(calls.writer, 0)
    assert.equal(calls.initialEmailProvider, 0)
  }

  // Case E: full personalisation preserves the pre-Prompt-4 contact finder,
  // website enrichment, Writer inputs/output path, and AI provenance.
  {
    const calls = counters()
    const db = new MemoryDb([baseLead])
    const result = await researchThenGenerate(db, baseLead, 'full_personalisation', 'ai_personalised', {
      fetchRawHtml: async () => '<p>Escape room details</p>',
      extractMailtoEmail: () => null,
      agenticEmailSearch: async () => {
        calls.contactFallback++
        return { email: 'ai@example.com', method: 'agentic', rounds: 1 }
      },
      extractWebsiteData: async () => {
        calls.personalisation++
        return { description: 'Existing AI description', services: 'Existing AI services', instagram_handle: null, facebook_url: null, other_social: null }
      },
    }, async (input) => {
      calls.writer++
      calls.initialEmailProvider++
      assert.equal(input.description, 'Existing AI description')
      assert.equal(input.services, 'Existing AI services')
      return { subject: 'AI subject', body: 'AI body' }
    })
    assert.equal(result.generated?.ok && result.generated.generationSource, 'ai')
    assert.equal(calls.contactFallback, 1)
    assert.equal(calls.personalisation, 1)
    assert.equal(calls.writer, 1, 'AI Personalised calls the existing Writer exactly once')
    assert.equal(calls.initialEmailProvider, 1)
    assert.equal(db.tables.emails[0].generation_source, 'ai')
  }

  console.log('Template contact-discovery and Initial Email AI-boundary checks passed')
}

main().catch((error) => { console.error(error); process.exit(1) })
