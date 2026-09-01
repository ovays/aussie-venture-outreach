import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { SupabaseClient } from '@supabase/supabase-js'
import { handleBulkDeleteRequest } from '../src/lib/bulk-delete-request'
import { deleteLeads, LEAD_DELETE_BATCH_SIZE, normalizeLeadIds } from '../src/lib/delete-leads'
import {
  selectableLeadIds,
  setLeadSelected,
  setPageSelected,
} from '../src/lib/delivery-failure-selection'
import type { DeliveryFailureRecord } from '../src/lib/delivery-failure-report'

const LEAD_A = '11111111-1111-4111-8111-111111111111'
const LEAD_B = '22222222-2222-4222-8222-222222222222'
const LEAD_C = '33333333-3333-4333-8333-333333333333'

function row(emailId: string, leadId: string | null): DeliveryFailureRecord {
  return {
    email_id: emailId,
    lead_id: leadId,
    business_name: leadId ? `Business ${leadId}` : null,
    email_address: 'test@example.com',
    category: null,
    city: null,
    failure_status: 'failed',
    email_type: 'initial_pitch',
    failure_date: '2026-08-31T00:00:00.000Z',
    resend_id: null,
    failure_source: 'local_api',
    provider: 'Local/API',
    failure_reason: 'Test failure',
  }
}

const duplicateRows = [row('email-a1', LEAD_A), row('email-a2', LEAD_A), row('email-b1', LEAD_B)]

// 1. Selecting one row selects exactly its unique lead.
let selected = setLeadSelected(new Set(), LEAD_A, true)
assert.deepEqual([...selected], [LEAD_A])

// 2. Header selection selects every unique lead on the current page.
selected = setPageSelected(new Set(), duplicateRows, true)
assert.deepEqual([...selected].sort(), [LEAD_A, LEAD_B].sort())

// 3. Header deselection affects the current page leads.
selected = setPageSelected(new Set([LEAD_A, LEAD_B, LEAD_C]), duplicateRows, false)
assert.deepEqual([...selected], [LEAD_C])

// 4. Duplicate failure rows produce one selected lead ID.
assert.deepEqual(selectableLeadIds(duplicateRows), [LEAD_A, LEAD_B])

// 5. The endpoint normalizer validates and deduplicates UUIDs server-side.
assert.deepEqual(normalizeLeadIds([LEAD_A, LEAD_A, LEAD_B]), [LEAD_A, LEAD_B])
assert.throws(() => normalizeLeadIds([LEAD_A, 'not-a-uuid']), /valid UUIDs/)

// 9. Historical failures without an active lead cannot become selectable.
assert.deepEqual(selectableLeadIds([row('historical', null)]), [])

// 10. A changed filter/search scope clears selection in the component.
const component = readFileSync(resolve('src/components/delivery-failures/DeliveryFailuresTable.tsx'), 'utf8')
assert.match(component, /setSelectedLeadIds\(new Set\(\)\)[\s\S]*\}, \[search, statusFilter, typeFilter\]\)/)

// 11. Page selection never adds a lead that is not represented on that page.
selected = setPageSelected(new Set(), [row('email-a', LEAD_A)], true)
assert.equal(selected.has(LEAD_B), false)
assert.match(component, /if \(!allFilteredSelected\) clearSelection\(\)[\s\S]*setPage\(nextPage\)/)

// 12. Select-all-filtered uses the same current status/type/search filters.
const selectionRoute = readFileSync(resolve('src/app/api/delivery-failures/lead-selection/route.ts'), 'utf8')
assert.match(selectionRoute, /parseDeliveryFailureFilters\(request\.nextUrl\.searchParams\)/)
assert.match(selectionRoute, /p_status: filters\.status[\s\S]*p_email_type: filters\.emailType[\s\S]*p_search: escapePostgresLikeTerm\(filters\.search\)/)
const migration = readFileSync(resolve('supabase/migrations/045_delivery_failure_lead_selection.sql'), 'utf8')
assert.match(migration, /SELECT DISTINCT eligible\.lead_id/, 'filtered selection deduplicates lead_id in SQL')
assert.match(migration, /JOIN public\.leads/, 'historical lead-less rows are excluded from filtered selection')

// 13. This feature does not touch Finder, blacklists, or duplicate detection.
const helper = readFileSync(resolve('src/lib/delete-leads.ts'), 'utf8')
const bulkRoute = readFileSync(resolve('src/app/api/leads/bulk-delete/route.ts'), 'utf8')
for (const source of [helper, bulkRoute, migration]) {
  assert.doesNotMatch(source, /from\('(blacklist|exhausted_queries|search_cache)'\)|@\/lib\/write-lead|@\/lib\/finder/i)
}

// 14. The route wires its authenticated-user guard into the request handler.
assert.match(bulkRoute, /authenticate: async \(\) =>/)
assert.match(bulkRoute, /await requireApiUser\(\)/)

type DbRow = Record<string, string | null>

class FakeQuery implements PromiseLike<{ data: DbRow[] | null; error: { message: string } | null }> {
  private operation: 'select' | 'delete' = 'select'
  private column = 'id'
  private values: string[] = []
  private returnRows = false

  constructor(
    private readonly table: string,
    private readonly tables: Record<string, DbRow[]>,
    private readonly deleteCalls: Array<{ table: string; ids: string[] }>,
  ) {}

  select(): this {
    this.returnRows = true
    return this
  }

  delete(): this {
    this.operation = 'delete'
    return this
  }

  in(column: string, values: string[]): this {
    this.column = column
    this.values = values
    return this
  }

  then<TResult1 = { data: DbRow[] | null; error: { message: string } | null }, TResult2 = never>(
    onfulfilled?: ((value: { data: DbRow[] | null; error: { message: string } | null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    try {
      if (this.values.length > LEAD_DELETE_BATCH_SIZE) {
        return Promise.resolve({
          data: null,
          error: { message: 'Bad Request: oversized in() filter' },
        }).then(onfulfilled, onrejected)
      }
      const rows = this.tables[this.table] ?? []
      const matches = rows.filter((item) => this.values.includes(String(item[this.column])))
      if (this.operation === 'delete') {
        this.deleteCalls.push({ table: this.table, ids: [...this.values] })
        this.tables[this.table] = rows.filter((item) => !this.values.includes(String(item[this.column])))
        if (this.table === 'leads') {
          for (const childTable of ['follow_ups', 'dm_queue', 'deals', 'emails']) {
            this.tables[childTable] = (this.tables[childTable] ?? [])
              .filter((item) => !this.values.includes(String(item.lead_id)))
          }
          for (const item of this.tables.activity_log ?? []) {
            if (this.values.includes(String(item.lead_id))) item.lead_id = null
          }
        }
      }
      return Promise.resolve({
        data: this.operation === 'select' || this.returnRows ? matches.map((item) => ({ ...item })) : null,
        error: null,
      }).then(onfulfilled, onrejected)
    } catch (error) {
      return Promise.reject(error).then(onfulfilled, onrejected)
    }
  }
}

function fakeDatabase(leadIds: string[]) {
  const tables: Record<string, DbRow[]> = {
    leads: leadIds.map((id) => ({ id })),
    follow_ups: [{ id: 'follow-a', lead_id: LEAD_A }, { id: 'follow-b', lead_id: LEAD_B }],
    dm_queue: [{ id: 'dm-a', lead_id: LEAD_A }],
    deals: [{ id: 'deal-b', lead_id: LEAD_B }],
    emails: [{ id: 'email-a', lead_id: LEAD_A }, { id: 'email-b', lead_id: LEAD_B }],
    activity_log: [{ id: 'audit-a', lead_id: LEAD_A }],
  }
  const deleteCalls: Array<{ table: string; ids: string[] }> = []
  const fakeSupabase = {
    from(table: string) {
      return new FakeQuery(table, tables, deleteCalls)
    },
  } as unknown as SupabaseClient

  return { fakeSupabase, tables, deleteCalls }
}

function uuid(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`
}

function requestFor(leadIds: unknown): Request {
  return new Request('http://localhost/api/leads/bulk-delete', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lead_ids: leadIds }),
  })
}

async function authenticatedRequest(request: Request, supabase: SupabaseClient): Promise<Response> {
  return handleBulkDeleteRequest(request, {
    authenticate: async () => null,
    createClient: async () => supabase,
  })
}

async function testBulkDeletion() {
  // 1. One lead can be deleted through the same bulk request handler.
  const oneDb = fakeDatabase([LEAD_A])
  const oneResponse = await authenticatedRequest(requestFor([LEAD_A]), oneDb.fakeSupabase)
  assert.equal(oneResponse.status, 200)
  assert.deepEqual(await oneResponse.json(), {
    requested: 1,
    matched: 1,
    deleted: 1,
    missing: 0,
    deleted_ids: [LEAD_A],
    missing_ids: [],
  })

  const { fakeSupabase, tables, deleteCalls } = fakeDatabase([LEAD_A, LEAD_B])

  // 2. Multiple selected leads retain the established cascading semantics.
  const result = await deleteLeads(fakeSupabase, [LEAD_A, LEAD_B])
  assert.equal(result.deleted, 2)
  assert.equal(tables.leads.length, 0)
  assert.deepEqual(deleteCalls.map(({ table }) => table), ['leads'])
  assert.equal(tables.emails.length, 0)
  assert.equal(tables.follow_ups.length, 0)
  assert.equal(tables.dm_queue.length, 0)
  assert.equal(tables.deals.length, 0)
  assert.equal(tables.activity_log.length, 1, 'historical activity remains untouched')
  assert.equal(tables.activity_log[0].lead_id, null, 'historical activity is detached from the lead')

  // 3. Duplicate IDs are deduplicated before lookup and deletion.
  const duplicateDb = fakeDatabase([LEAD_A, LEAD_B])
  const duplicateResponse = await authenticatedRequest(
    requestFor([LEAD_A, LEAD_A, LEAD_B]),
    duplicateDb.fakeSupabase,
  )
  assert.equal(duplicateResponse.status, 200)
  const duplicateResult = await duplicateResponse.json() as { requested: number; deleted: number }
  assert.deepEqual(duplicateResult, {
    requested: 2,
    matched: 2,
    deleted: 2,
    missing: 0,
    deleted_ids: [LEAD_A, LEAD_B],
    missing_ids: [],
  })

  // 4 & 8. 841+ IDs stay in one client request and are safely batched server-side.
  const largeIds = Array.from({ length: 842 }, (_, index) => uuid(index + 1))
  const largeDb = fakeDatabase(largeIds)
  const largeResponse = await authenticatedRequest(requestFor(largeIds), largeDb.fakeSupabase)
  assert.equal(largeResponse.status, 200, 'selection size alone must not produce a 400')
  const largeResult = await largeResponse.json() as { requested: number; deleted: number; missing: number }
  assert.equal(largeResult.requested, 842)
  assert.equal(largeResult.deleted, 842)
  assert.equal(largeResult.missing, 0)
  assert(largeDb.deleteCalls.length > 1, 'large deletion is split into database batches')
  assert(
    largeDb.deleteCalls.every(({ ids }) => ids.length <= LEAD_DELETE_BATCH_SIZE),
    'no database filter exceeds the safe batch size',
  )

  // 5. An invalid UUID is a useful 400 and no database client is created.
  let invalidCreatedClient = false
  const invalidResponse = await handleBulkDeleteRequest(requestFor([LEAD_A, 'not-a-uuid']), {
    authenticate: async () => null,
    createClient: async () => {
      invalidCreatedClient = true
      return fakeDatabase([]).fakeSupabase
    },
  })
  assert.equal(invalidResponse.status, 400)
  assert.match((await invalidResponse.json() as { error: string }).error, /valid UUIDs/)
  assert.equal(invalidCreatedClient, false)

  // Database errors retain the failing phase/batch in both the response and logs.
  const failingSupabase = {
    from() {
      return {
        select() { return this },
        in() {
          return Promise.resolve({ data: null, error: { message: 'Bad Request from database proxy' } })
        },
      }
    },
  } as unknown as SupabaseClient
  const loggedErrors: Array<{ message: string; context: unknown }> = []
  const failedResponse = await handleBulkDeleteRequest(requestFor([LEAD_A]), {
    authenticate: async () => null,
    createClient: async () => failingSupabase,
    logError: (message, context) => loggedErrors.push({ message, context }),
  })
  assert.equal(failedResponse.status, 500)
  const failedBody = await failedResponse.json() as { error: string; phase: string; batch: number }
  assert.match(failedBody.error, /lookup batch 1 of 1 failed: Bad Request from database proxy/)
  assert.equal(failedBody.phase, 'lookup')
  assert.equal(failedBody.batch, 1)
  assert.equal(loggedErrors.length, 1)

  // 6. An already-deleted/missing lead is safely reported as missing.
  const missingDb = fakeDatabase([])
  const missing = await deleteLeads(missingDb.fakeSupabase, [LEAD_A, LEAD_C])
  assert.deepEqual(missing, {
    requested: 2,
    matched: 0,
    deleted: 0,
    missing: 2,
    deleted_ids: [],
    missing_ids: [LEAD_A, LEAD_C],
  })

  // 7. Authentication is checked before parsing or creating a database client.
  let unauthCreatedClient = false
  const unauthenticated = await handleBulkDeleteRequest(requestFor([LEAD_A]), {
    authenticate: async () => Response.json({ error: 'Authentication required' }, { status: 401 }),
    createClient: async () => {
      unauthCreatedClient = true
      return fakeDatabase([]).fakeSupabase
    },
  })
  assert.equal(unauthenticated.status, 401)
  assert.equal(unauthCreatedClient, false)

  // Existing single Delete Lead still targets its established endpoint.
  assert.match(component, /fetch\(`\/api\/leads\/\$\{deleteTarget\.lead_id\}`/)
  assert.match(component, /title="Delete lead\?"/)

  console.log('Delivery failure bulk-delete tests passed')
}

void testBulkDeletion()
