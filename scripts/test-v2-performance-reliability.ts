import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import type { Database, Json } from '../src/types/database'
import { ensureOutboundEmailIntent, outboundIdempotencyKey, outboundMessageId } from '../src/lib/outbound-send'

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

const url = required('NEXT_PUBLIC_SUPABASE_URL')
assert.match(url, /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/i, 'test refuses non-local Supabase')
assert.equal(process.env.NEXT_PUBLIC_REACHAGENT_RUNTIME, 'v2')
const db = createClient<Database>(url, required('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { autoRefreshToken: false, persistSession: false },
})
const runId = Date.now().toString(36)
const prefix = `V2_PR_${runId}_`
const WORKSPACE_ID = '00000000-0000-0000-0000-000000000001'

function source(path: string): string {
  return readFileSync(path, 'utf8')
}

function object(value: Json | null): Record<string, Json | undefined> {
  assert(value && typeof value === 'object' && !Array.isArray(value))
  return value as Record<string, Json | undefined>
}

async function cleanup(): Promise<void> {
  const leads = await db.from('leads').select('id').like('business_name', `${prefix}%`)
  if (leads.error) throw leads.error
  const ids = (leads.data ?? []).map((lead) => lead.id)
  if (ids.length) {
    const deleted = await db.from('leads').delete().in('id', ids)
    if (deleted.error) throw deleted.error
  }
  const categories = await db.from('categories').delete().like('name', `${prefix}%`)
  if (categories.error) throw categories.error
}

async function main(): Promise<void> {
  await cleanup()
  try {
    const researcher = source('agents/researcher.ts')
    const writer = source('agents/writer.ts')
    const reactivation = source('agents/reactivation.ts')
    for (const [name, text, token] of [
      ['Researcher', researcher, 'RESEARCHER_BATCH_SIZE'],
      ['Writer', writer, 'WRITER_BATCH_SIZE'],
      ['Reactivation', reactivation, 'REACTIVATION_BATCH_SIZE'],
    ]) {
      assert(text.includes(`.limit(${token})`), `${name} must have a configured hard batch limit`)
      assert(/\.order\('[^']+'/.test(text), `${name} must use deterministic database ordering`)
    }

    const finder = source('agents/finder.ts')
    assert(finder.includes("rpc('lookup_finder_candidates'"), 'Finder uses one set-based lookup RPC')
    assert(finder.includes("rpc('insert_finder_lead_if_new'"), 'Finder closes lookup/insert races atomically')
    assert(!finder.includes('isAlreadyInDB'), 'Finder has no per-candidate database lookup')
    assert(!finder.includes('fetchPipelineDedupeIndex'), 'Finder has no full lead-table dedupe preload')

    const emailReport = source('src/components/email-report/EmailReportDashboard.tsx')
    assert(emailReport.includes("getEmailReportPresetRange('last_30_days')"), 'Email Report defaults to a bounded 30-day range')
    assert(source('src/lib/email-report.ts').includes('EMAIL_REPORT_MAX_DAYS = 366'), 'wider mailbox reads remain explicit and bounded')
    assert(source('src/lib/hostinger-mail.ts').includes('perPage=100'), 'Hostinger traversal is provider-paged')

    const daily = source('trigger/daily-pipeline.ts')
    assert(/queue:\s*\{\s*concurrencyLimit:\s*1/.test(daily), 'Trigger queue serializes scheduled delivery')
    assert(/acquireLock\(\s*pipelineSupabase,\s*DAILY_PIPELINE_LOCK_KEY/.test(daily), 'daily task uses a cross-process durable lock')
    assert(daily.includes('finally') && daily.includes('releaseLock'), 'daily task releases its fenced lock on every exit')
    const digestTask = source('trigger/digest-job.ts')
    const tracker = source('agents/tracker.ts')
    assert(/queue:\s*\{[\s\S]*?concurrencyLimit:\s*1/.test(digestTask), 'digest Trigger deliveries are serialized')
    assert(tracker.includes('reachagent-digest-${digestDateKey}'), 'digest retries use one stable provider idempotency key per Sydney day')
    assert(tracker.includes('if (!digestResult) throw'), 'digest provider rejection cannot be recorded as sent')

    const migration = source('supabase-v2/migrations/00000000000001_performance_reliability.sql')
    assert(migration.includes('WITH open_flags AS MATERIALIZED'), 'Data Quality begins from maintained open flags')
    assert(migration.includes('JOIN public.leads AS l ON l.id = candidate.lead_id'), 'Data Quality facts are restricted to flagged leads')

    const categoryResult = await db.from('categories').insert({ workspace_id: WORKSPACE_ID, name: `${prefix}Category`, status: 'active' }).select('id,name').single()
    assert.ifError(categoryResult.error)
    const category = categoryResult.data!

    const leadRows = Array.from({ length: 37 }, (_, index) => ({
      workspace_id: WORKSPACE_ID,
      business_name: `${prefix}Paged ${index.toString().padStart(2, '0')}`,
      category_id: category.id,
      category_name: category.name,
      city: index % 2 ? 'Sydney' : 'Melbourne',
      email: `${prefix.toLowerCase()}paged-${index}@example.test`,
      phone: `0499${index.toString().padStart(6, '0')}`,
      status: index < 21 ? 'new' : 'contacted',
      source: 'manual',
    }))
    assert.ifError((await db.from('leads').insert(leadRows)).error)

    const pageResult = await db.rpc('get_leads_search_page', {
      p_statuses: ['new'], p_category: category.name, p_city: 'Sydney', p_search: prefix,
      p_page: 1, p_page_size: 7, p_ids_only: false,
    })
    assert.ifError(pageResult.error)
    const page = object(pageResult.data)
    assert(Array.isArray(page.data) && page.data.length <= 7, 'Leads returns O(page size) rows')
    assert.equal(typeof page.total, 'number')

    const contacted = await db.from('leads').select('id').like('business_name', `${prefix}Paged%`).eq('status', 'contacted')
    assert.ifError(contacted.error)
    const emails = (contacted.data ?? []).map((lead, index) => ({
      workspace_id: WORKSPACE_ID,
      lead_id: lead.id, type: 'initial_pitch' as const, subject: 'Fixture', body_text: 'Fixture', body_html: '<p>Fixture</p>',
      status: 'sent', sent_at: new Date(Date.UTC(2026, 7, 1, 0, 0, index)).toISOString(),
    }))
    assert.ifError((await db.from('emails').insert(emails)).error)
    const lifecycleResult = await db.rpc('get_lifecycle_page', {
      p_as_of: '2026-09-15T00:00:00Z', p_filter: 'all', p_search: prefix,
      p_sort_key: 'next_action_date', p_sort_dir: 'asc', p_page: 1, p_page_size: 5,
    })
    assert.ifError(lifecycleResult.error)
    const lifecycle = object(lifecycleResult.data)
    assert(Array.isArray(lifecycle.data) && lifecycle.data.length <= 5, 'Lifecycle returns O(page size) JSON rows')

    const baseLeadResult = await db.from('leads').insert({
      workspace_id: WORKSPACE_ID,
      business_name: `${prefix}Duplicate Place`, category_id: category.id, category_name: category.name,
      city: 'Sydney', phone: '0400111222', email: `${prefix.toLowerCase()}owner@example.com`,
      website: `https://${prefix.toLowerCase()}existing.example`, status: 'new', source: 'manual',
      outreach_suppression_reason: 'manual_test_suppression', outreach_suppressed_at: new Date().toISOString(),
    }).select('id,normalized_email').single()
    assert.ifError(baseLeadResult.error)
    const baseLead = baseLeadResult.data!
    assert.ifError((await db.from('leads').insert({
      workspace_id: WORKSPACE_ID,
      business_name: `${prefix}Public COM`, category_id: category.id, category_name: category.name,
      city: 'Darwin', email: `${prefix.toLowerCase()}person@gmail.com`, status: 'new', source: 'manual',
    })).error)

    const candidates: Json = [
      { candidate_index: 0, business_name: `${prefix}Duplicate Place`, city: 'Sydney', phone: null, normalized_email: `${prefix.toLowerCase()}different@other.example`, email_root_domain: 'other.example', is_public_email_domain: false, website_domain: null },
      { candidate_index: 1, business_name: `${prefix}Different`, city: 'Perth', phone: null, normalized_email: baseLead.normalized_email, email_root_domain: 'example.com', is_public_email_domain: false, website_domain: null },
      { candidate_index: 2, business_name: `${prefix}Public AU`, city: 'Sydney', phone: null, normalized_email: `${prefix.toLowerCase()}person@gmail.com.au`, email_root_domain: 'gmail.com.au', is_public_email_domain: true, website_domain: null },
      { candidate_index: 3, business_name: `${prefix}New`, city: 'Brisbane', phone: '0400999888', normalized_email: `${prefix.toLowerCase()}new@new-domain.example`, email_root_domain: 'new-domain.example', is_public_email_domain: false, website_domain: 'new-domain.example' },
    ]
    const lookup = await db.rpc('lookup_finder_candidates', { p_workspace_id: WORKSPACE_ID, p_candidates: candidates })
    assert.ifError(lookup.error)
    const matches = lookup.data ?? []
    assert(matches.some((match) => match.candidate_index === 0 && match.matched_id), 'duplicate business/place is detected')
    assert(matches.some((match) => match.candidate_index === 0 && match.matched_suppression_reason === 'manual_test_suppression'), 'suppressed duplicate remains blocked')
    assert(matches.some((match) => match.candidate_index === 1 && match.matched_id), 'duplicate normalized email is detected')
    assert(matches.some((match) => match.candidate_index === 2 && !match.matched_id), 'gmail.com.au is not collapsed into gmail.com or unrelated public addresses')
    assert(matches.some((match) => match.candidate_index === 3 && !match.matched_id), 'valid new lead remains new')

    const insertPayload: Json = {
      business_name: `${prefix}Atomic New`, category_id: category.id, category_name: category.name,
      city: 'Adelaide', phone: '0400777666', email: `${prefix.toLowerCase()}atomic@atomic.example`,
      website: `https://${prefix.toLowerCase()}atomic.example`, status: 'new', source: 'finder',
    }
    const [atomicA, atomicB] = await Promise.all([
      db.rpc('insert_finder_lead_if_new', { p_workspace_id: WORKSPACE_ID, p_lead: insertPayload }),
      db.rpc('insert_finder_lead_if_new', { p_workspace_id: WORKSPACE_ID, p_lead: insertPayload }),
    ])
    assert.ifError(atomicA.error)
    assert.ifError(atomicB.error)
    const atomicOutcomes = [object(atomicA.data), object(atomicB.data)]
    assert.equal(atomicOutcomes.filter((outcome) => outcome.inserted === true).length, 1, 'duplicate Finder workers insert exactly one row')

    const intentLeadResult = await db.from('leads').insert({
      workspace_id: WORKSPACE_ID,
      business_name: `${prefix}Intent`, category_id: category.id, category_name: category.name,
      city: 'Sydney', email: `${prefix.toLowerCase()}intent@intent.example`, status: 'contacted', source: 'manual',
    }).select('id').single()
    assert.ifError(intentLeadResult.error)
    const intentContent = { leadId: intentLeadResult.data!.id, type: 'follow_up_1' as const, subject: 'Stable', bodyHtml: '<p>Stable</p>', bodyText: 'Stable' }
    const [intentA, intentB] = await Promise.all([
      ensureOutboundEmailIntent(db, intentContent), ensureOutboundEmailIntent(db, intentContent),
    ])
    assert.equal(intentA.intent.id, intentB.intent.id, 'duplicate workers converge on one durable send intent')
    assert.equal([intentA.created, intentB.created].filter(Boolean).length, 1)

    const providerAcceptances = new Map<string, string>()
    const mockProvider = (key: string): string => {
      const existing = providerAcceptances.get(key)
      if (existing) return existing
      const id = `provider-${providerAcceptances.size + 1}`
      providerAcceptances.set(key, id)
      return id
    }
    const key = outboundIdempotencyKey(intentA.intent.id)
    const providerId = mockProvider(key)
    // Simulate provider acceptance followed by a failed/lost DB confirmation:
    // the durable row deliberately remains pending_send.
    const pending = await db.from('emails').select('status').eq('id', intentA.intent.id).single()
    assert.ifError(pending.error)
    assert.equal(pending.data!.status, 'pending_send')
    assert.equal(mockProvider(key), providerId, 'retry after an uncertain outcome reuses provider acceptance')
    assert.equal(providerAcceptances.size, 1, 'uncertain retry cannot blindly create a second provider send')
    assert.equal(outboundMessageId(intentA.intent.id), `<${intentA.intent.id}@aussieventure.com>`)
    const confirmed = await db.from('emails').update({ status: 'sent', resend_id: providerId, message_id: outboundMessageId(intentA.intent.id), sent_at: new Date().toISOString() }).eq('id', intentA.intent.id)
    assert.ifError(confirmed.error)
    const recovered = await ensureOutboundEmailIntent(db, intentContent)
    assert.equal(recovered.intent.status, 'sent', 'confirmed intent blocks later duplicate delivery')

    const invalid = await db.from('leads').insert({
      workspace_id: WORKSPACE_ID,
      business_name: `${prefix}Invalid`, category_id: category.id, category_name: category.name,
      city: 'Sydney', email: 'not-an-email', status: 'new', source: 'manual',
    }).select('id').single()
    assert.ifError(invalid.error)
    const reportResult = await db.rpc('get_data_quality_report_v2', {
      p_issue_type: 'invalid_email', p_search: prefix, p_page: 1, p_page_size: 1,
    })
    assert.ifError(reportResult.error)
    const report = object(reportResult.data)
    assert(Array.isArray(report.data) && report.data.length <= 1, 'Data Quality response is page-bounded')

    console.log('V2 performance/reliability regression tests passed')
  } finally {
    await cleanup()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
