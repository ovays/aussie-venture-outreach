import assert from 'node:assert/strict'
import {
  createPaginatedResponse,
  DEFAULT_PAGE,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  resolvePagination,
  toSupabaseRange,
} from '../src/lib/pagination'

const defaults = resolvePagination()
assert.deepEqual(defaults, { page: DEFAULT_PAGE, pageSize: DEFAULT_PAGE_SIZE })

const requested = resolvePagination({ page: '3', pageSize: '25' })
assert.deepEqual(requested, { page: 3, pageSize: 25 })
assert.deepEqual(toSupabaseRange(requested), { from: 50, to: 74 })

assert.deepEqual(resolvePagination({ page: '-2', pageSize: '0' }), defaults)
assert.deepEqual(resolvePagination({ page: '2.5', pageSize: 'abc' }), defaults)
assert.deepEqual(resolvePagination({ page: Number.MAX_SAFE_INTEGER + 1 }), defaults)
assert.equal(resolvePagination({ pageSize: '999' }).pageSize, MAX_PAGE_SIZE)

assert.deepEqual(
  resolvePagination(
    { page: '4', pageSize: '500' },
    { defaultPage: 2, defaultPageSize: 25, maxPageSize: 200 },
  ),
  { page: 4, pageSize: 200 },
)

assert.throws(
  () => resolvePagination({}, { defaultPageSize: 101, maxPageSize: 100 }),
  /defaultPageSize must not exceed maxPageSize/,
)
assert.throws(
  () => toSupabaseRange({ page: Number.MAX_SAFE_INTEGER, pageSize: 2 }),
  /pagination range exceeds/,
)

assert.deepEqual(createPaginatedResponse(['a', 'b'], { page: 2, pageSize: 50 }, 101), {
  data: ['a', 'b'],
  page: 2,
  pageSize: 50,
  total: 101,
  totalPages: 3,
})
assert.equal(createPaginatedResponse([], defaults, 0).totalPages, 0)
assert.throws(() => createPaginatedResponse([], defaults, -1), /total must be a non-negative/)

console.log('Pagination utility tests passed')
