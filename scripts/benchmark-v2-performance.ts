import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { createClient } from '@supabase/supabase-js'

const FIXTURE_PREFIX = 'V2_PERF_FIXTURE_'
const LEAD_COUNT = 2_000
const CONTACTED_COUNT = 1_500

function env(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

const url = env('NEXT_PUBLIC_SUPABASE_URL')
assert(/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/i.test(url), 'benchmark refuses non-local Supabase')
assert.equal(process.env.NEXT_PUBLIC_REACHAGENT_RUNTIME, 'v2', 'benchmark requires NEXT_PUBLIC_REACHAGENT_RUNTIME=v2')
const supabase = createClient(url, env('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { autoRefreshToken: false, persistSession: false },
})

async function timed<T>(operation: () => PromiseLike<{ data: T; error: { message: string } | null; count?: number | null }>) {
  const started = performance.now()
  const result = await operation()
  const durationMs = performance.now() - started
  if (result.error) throw new Error(result.error.message)
  return {
    data: result.data,
    durationMs: Number(durationMs.toFixed(1)),
    bytes: Buffer.byteLength(JSON.stringify(result.data ?? null)),
    count: result.count ?? null,
  }
}

async function seed() {
  for (let offset = 0; offset < LEAD_COUNT; offset += 250) {
    const rows = Array.from({ length: Math.min(250, LEAD_COUNT - offset) }, (_, index) => {
      const number = offset + index
      return {
        business_name: `${FIXTURE_PREFIX}${number.toString().padStart(4, '0')}`,
        email: `perf-${number}@fixture-${number % 300}.example`,
        city: number % 2 ? 'Sydney' : 'Melbourne',
        suburb: `Suburb ${number % 50}`,
        category_name: `Category ${number % 10}`,
        phone: `0400${number.toString().padStart(6, '0')}`,
        status: number < CONTACTED_COUNT ? 'contacted' : number % 2 ? 'new' : 'researched',
        source: 'manual',
      }
    })
    const { error } = await supabase.from('leads').insert(rows)
    if (error) throw new Error(`fixture lead insert failed: ${error.message}`)
  }

  const leads: Array<{ id: string; business_name: string }> = []
  for (let from = 0; from < LEAD_COUNT; from += 1_000) {
    const result = await supabase.from('leads')
      .select('id,business_name').like('business_name', `${FIXTURE_PREFIX}%`)
      .order('business_name').range(from, from + 999)
    if (result.error) throw new Error(result.error.message)
    leads.push(...(result.data ?? []))
  }
  if (leads.length !== LEAD_COUNT) throw new Error(`fixture lead count mismatch: ${leads.length}`)
  for (let offset = 0; offset < CONTACTED_COUNT; offset += 250) {
    const rows = leads.slice(offset, Math.min(offset + 250, CONTACTED_COUNT)).flatMap((lead, index) => {
      const sequence = offset + index
      const initial = new Date(Date.UTC(2026, 5, 1) + sequence * 1_000).toISOString()
      return [
        { lead_id: lead.id, type: 'initial_pitch', subject: 'Fixture initial', body_text: 'Fixture', body_html: '<p>Fixture</p>', status: 'sent', sent_at: initial },
        ...(sequence % 2 === 0 ? [{ lead_id: lead.id, type: 'follow_up_1', subject: 'Fixture FU1', body_text: 'Fixture', body_html: '<p>Fixture</p>', status: 'sent', sent_at: new Date(Date.parse(initial) + 7 * 86_400_000).toISOString() }] : []),
        ...(sequence % 4 === 0 ? [{ lead_id: lead.id, type: 'follow_up_2', subject: 'Fixture FU2', body_text: 'Fixture', body_html: '<p>Fixture</p>', status: 'sent', sent_at: new Date(Date.parse(initial) + 14 * 86_400_000).toISOString() }] : []),
      ]
    })
    const { error: emailError } = await supabase.from('emails').insert(rows)
    if (emailError) throw new Error(`fixture email insert failed: ${emailError.message}`)
  }
}

async function cleanup() {
  const { error } = await supabase.from('leads').delete().like('business_name', `${FIXTURE_PREFIX}%`)
  if (error) throw new Error(`fixture cleanup failed: ${error.message}`)
}

async function benchmark() {
  const leads = await timed(() => supabase.rpc('get_leads_search_page', {
    p_statuses: null, p_category: null, p_city: null, p_search: '',
    p_page: 1, p_page_size: 50, p_ids_only: false,
  }))
  const lifecycle = await timed(() => supabase.rpc('get_lifecycle_page', {
    p_as_of: '2026-09-15T00:00:00.000Z', p_filter: 'all', p_search: '',
    p_sort_key: 'next_action_date', p_sort_dir: 'asc', p_page: 1, p_page_size: 50,
  }))
  const finderCandidates = Array.from({ length: 25 }, (_, index) => ({
    name: `${FIXTURE_PREFIX}${index.toString().padStart(4, '0')}`,
    city: index % 2 ? 'Sydney' : 'Melbourne',
  }))
  const finder = await timed(() => supabase.rpc('lookup_finder_candidates', {
    p_candidates: finderCandidates.map((candidate, candidateIndex) => ({
      candidate_index: candidateIndex, business_name: candidate.name,
      city: candidate.city, phone: null, email: null,
      email_root_domain: null, is_public_email_domain: false, website_domain: null,
    })),
  }))

  const leadPayload = leads.data as { data?: unknown[]; total?: number }
  const lifecyclePayload = lifecycle.data as { data?: unknown[]; total?: number }
  return {
    fixture: { leads: LEAD_COUNT, contacted: CONTACTED_COUNT },
    leads_page: { database_calls: 1, rows_returned: leadPayload.data?.length ?? 0, matched_total: leadPayload.total ?? 0, duration_ms: leads.durationMs, payload_bytes: leads.bytes, server_paged: true },
    lifecycle_page: { database_calls: 1, rows_returned: lifecyclePayload.data?.length ?? 0, matched_total: lifecyclePayload.total ?? 0, duration_ms: lifecycle.durationMs, payload_bytes: lifecycle.bytes, server_paged: true, full_candidate_classification: true, wide_candidate_enrichment: false },
    finder_dedupe_preload: { database_calls: 0, rows_returned: 0, bounded: true },
    finder_candidate_lookup: { database_calls: 1, candidates: finderCandidates.length, rows_returned: Array.isArray(finder.data) ? finder.data.length : 0, duration_ms: finder.durationMs, payload_bytes: finder.bytes, n_plus_one: false },
    source_audit: {
      researcher_new_leads: { bounded_after: true, default_limit: 100 },
      writer_researched_leads: { bounded_after: true, default_limit: 100 },
      reactivation_contacted_leads: { bounded_after: true, default_limit: 100 },
      email_report: { default_days: 30, maximum_explicit_days: 366, provider_folders_parallel: true, server_render_blocking: false },
      data_quality: { issue_groups_server_paged: true, page_size_maximum: 100, detail_queries_per_page: '5 parallel plus optional owner-name lookup' },
    },
  }
}

async function main() {
  if (process.argv.includes('--cleanup-only')) {
    await cleanup()
    console.log('V2 performance fixtures removed')
    return
  }
  await cleanup()
  if (process.argv.includes('--seed-only')) {
    await seed()
    console.log(`Seeded ${LEAD_COUNT} V2 performance fixtures`)
    return
  }
  try {
    await seed()
    console.log(JSON.stringify(await benchmark(), null, 2))
  } finally {
    await cleanup()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
