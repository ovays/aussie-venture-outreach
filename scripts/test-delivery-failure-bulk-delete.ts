import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { SupabaseClient } from '@supabase/supabase-js'
import { deleteLeads, normalizeLeadIds } from '../src/lib/delete-leads'
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
assert.match(selectionRoute, /p_status: filters\.status[\s\S]*p_email_type: filters\.emailType[\s\S]*p_search: filters\.search/)
const migration = readFileSync(resolve('supabase/migrations/045_delivery_failure_lead_selection.sql'), 'utf8')
assert.match(migration, /SELECT DISTINCT eligible\.lead_id/, 'filtered selection deduplicates lead_id in SQL')
assert.match(migration, /JOIN public\.leads/, 'historical lead-less rows are excluded from filtered selection')

// 13. This feature does not touch Finder, blacklists, or duplicate detection.
const helper = readFileSync(resolve('src/lib/delete-leads.ts'), 'utf8')
const bulkRoute = readFileSync(resolve('src/app/api/leads/bulk-delete/route.ts'), 'utf8')
for (const source of [helper, bulkRoute, migration]) {
  assert.doesNotMatch(source, /from\('(blacklist|exhausted_queries|search_cache)'\)|@\/lib\/write-lead|@\/lib\/finder/i)
}

// 14. The bulk endpoint has an explicit authenticated-user guard before deletion.
const authIndex = bulkRoute.indexOf('await requireApiUser()')
const deleteIndex = bulkRoute.indexOf('await deleteLeads')
assert(authIndex >= 0 && deleteIndex > authIndex)
assert.match(bulkRoute, /if \(isAuthErrorResponse\(auth\)\) return auth/)

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
      const rows = this.tables[this.table] ?? []
      const matches = rows.filter((item) => this.values.includes(String(item[this.column])))
      if (this.operation === 'delete') {
        this.deleteCalls.push({ table: this.table, ids: [...this.values] })
        this.tables[this.table] = rows.filter((item) => !this.values.includes(String(item[this.column])))
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

async function testBulkDeletion() {
  const tables: Record<string, DbRow[]> = {
    leads: [{ id: LEAD_A }, { id: LEAD_B }],
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

  // 6. Delete Selected removes both selected leads with batched table calls.
  const result = await deleteLeads(fakeSupabase, [LEAD_A, LEAD_B])
  assert.equal(result.deleted, 2)
  assert.equal(tables.leads.length, 0)
  assert.deepEqual(deleteCalls.map(({ table }) => table), ['follow_ups', 'dm_queue', 'deals', 'emails', 'leads'])
  assert(deleteCalls.every(({ ids }) => ids.length === 2), 'each table is deleted once for the full ID set')
  assert.equal(tables.activity_log.length, 1, 'historical activity remains untouched')

  // 8. An already-deleted/missing lead is a safe successful result.
  const missing = await deleteLeads(fakeSupabase, [LEAD_A, LEAD_C])
  assert.deepEqual(missing, {
    requested: 2,
    matched: 0,
    deleted: 0,
    missing: 2,
    deleted_ids: [],
    missing_ids: [LEAD_A, LEAD_C],
  })

  // 7. Existing single Delete Lead still targets its established endpoint.
  assert.match(component, /fetch\(`\/api\/leads\/\$\{deleteTarget\.lead_id\}`/)
  assert.match(component, /title="Delete lead\?"/)

  console.log('Delivery failure bulk-delete tests passed')
}

void testBulkDeletion()
