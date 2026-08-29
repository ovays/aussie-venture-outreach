import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  clampSuburbPriority,
  groupEffectiveSuburbPriorities,
  type CategorySuburbPriorityRecord,
  type CitySuburbRecord,
} from '../src/lib/suburb-priorities'

const suburbs: CitySuburbRecord[] = [
  { id: 'circular-quay', city: 'Sydney', suburb: 'Circular Quay', active: true, priority: 7 },
  { id: 'darling-harbour', city: 'Sydney', suburb: 'Darling Harbour', active: true, priority: 6 },
  { id: 'inactive', city: 'Sydney', suburb: 'Inactive Suburb', active: false, priority: 4 },
]

const global = groupEffectiveSuburbPriorities(suburbs)
assert.deepEqual(global.Sydney.map((row) => row.priority), [7, 6, 4], 'global mode retains city_suburbs priorities')
assert.equal(global.Sydney[2].active, false, 'global active/inactive state is retained')

const inherited = groupEffectiveSuburbPriorities(suburbs, [])
assert.deepEqual(inherited, global, 'a category with no mappings inherits Global / Default priorities')

const cruises: CategorySuburbPriorityRecord[] = [
  { city_suburb_id: 'circular-quay', priority: 10 },
  { city_suburb_id: 'darling-harbour', priority: 9 },
]
const customized = groupEffectiveSuburbPriorities(suburbs, cruises)
assert.deepEqual(customized.Sydney.map((row) => row.priority), [10, 9, 1], 'customized categories use 1 for every unmapped suburb')

const anotherCategory = groupEffectiveSuburbPriorities(suburbs, [
  { city_suburb_id: 'darling-harbour', priority: 3 },
])
assert.deepEqual(anotherCategory.Sydney.map((row) => row.priority), [1, 3, 1], 'category mappings remain independent')
assert.deepEqual(groupEffectiveSuburbPriorities(suburbs, []), global, 'reset returns immediately to inherited global priorities')
assert.equal(clampSuburbPriority(11), 10)
assert.equal(clampSuburbPriority(0), 1)
assert.equal(clampSuburbPriority(8.6), 9)

const root = resolve(import.meta.dirname, '..')
const route = readFileSync(resolve(root, 'src/app/api/city-suburbs/route.ts'), 'utf8')
const component = readFileSync(resolve(root, 'src/components/settings/CitySuburbs.tsx'), 'utf8')
const settingsPage = readFileSync(resolve(root, 'src/app/dashboard/settings/page.tsx'), 'utf8')

assert.match(route, /await requireApiUser\(\)/, 'suburb reads require an authenticated user')
for (const method of ['POST', 'PATCH', 'DELETE']) {
  const methodStart = route.indexOf(`export async function ${method}`)
  const nextMethod = route.indexOf('export async function', methodStart + 1)
  const methodSource = route.slice(methodStart, nextMethod === -1 ? undefined : nextMethod)
  assert.match(methodSource, /await requireApiAdmin\(\)/, `${method} requires an admin`)
}
assert.match(route, /\.eq\('category_id', categoryId\)/, 'GET fetches mappings for only the selected category')
assert.match(route, /onConflict: 'category_id,city_suburb_id'/, 'category priority writes upsert on the sparse unique key')
assert.match(route, /\.delete\(\)[\s\S]*\.eq\('category_id', parsed\.data\.categoryId\)/, 'reset deletes all mappings for only the selected category')
assert.doesNotMatch(route, /createServiceClient/, 'the route does not bypass user RLS with a service client')

assert.match(component, /Global \/ Default/, 'the selector exposes Global / Default mode')
assert.match(component, /Using Global \/ Default priorities/, 'inherited category state is clearly labelled')
assert.match(component, /Unmapped suburbs use priority 1/, 'customized category semantics are explained')
assert.match(component, /Reset to Global \/ Default/, 'category reset is available')
assert.match(component, /fetch\('\/api\/categories'\)/, 'category options refresh dynamically from the categories API')
assert.match(settingsPage, /initialCategories=/, 'server-rendered category options are supplied without a category-by-suburb query')

console.log('Settings suburb priority tests passed')
