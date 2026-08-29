import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  resolveCategorySuburbPriorities,
  type CategorySuburbPriorityRow,
  type FinderLocation,
} from '../agents/finder'

const globalLocations: FinderLocation[] = [
  { citySuburbId: 'lakemba', suburb: 'Lakemba', city: 'Sydney', state: 'NSW', priority: 10 },
  { citySuburbId: 'auburn', suburb: 'Auburn', city: 'Sydney', state: 'NSW', priority: 9 },
  { citySuburbId: 'quay', suburb: 'Circular Quay', city: 'Sydney', state: 'NSW', priority: 2 },
]

// No category configuration preserves values and existing object identity.
const fallback = resolveCategorySuburbPriorities(globalLocations, [])
assert.equal(fallback, globalLocations)
assert.deepEqual(fallback.map((location) => location.priority), [10, 9, 2])

const cruisesPriorities: CategorySuburbPriorityRow[] = [
  { category_id: 'cruises', city_suburb_id: 'quay', priority: 10 },
]
const cruises = resolveCategorySuburbPriorities(globalLocations, cruisesPriorities)
assert.deepEqual(cruises.map((location) => location.priority), [1, 1, 10])
assert.equal([...cruises].sort((a, b) => b.priority - a.priority)[0].suburb, 'Circular Quay')

const halalPriorities: CategorySuburbPriorityRow[] = [
  { category_id: 'halal', city_suburb_id: 'lakemba', priority: 8 },
  { category_id: 'halal', city_suburb_id: 'auburn', priority: 10 },
]
const halal = resolveCategorySuburbPriorities(globalLocations, halalPriorities)
assert.deepEqual(halal.map((location) => location.priority), [8, 10, 1])
assert.deepEqual(cruises.map((location) => location.priority), [1, 1, 10])
assert.deepEqual(globalLocations.map((location) => location.priority), [10, 9, 2])

const root = resolve(__dirname, '..')
const migration = readFileSync(
  resolve(root, 'supabase/migrations/041_category_suburb_priorities.sql'),
  'utf8'
)

assert.match(migration, /UNIQUE \(category_id, city_suburb_id\)/)
assert.match(migration, /priority BETWEEN 1 AND 10/)
assert.match(migration, /REFERENCES public\.categories\(id\) ON DELETE CASCADE/)
assert.match(migration, /REFERENCES public\.city_suburbs\(id\) ON DELETE CASCADE/)
assert.doesNotMatch(migration, /INSERT INTO public\.category_suburb_priorities/i)
assert.doesNotMatch(migration, /UPDATE public\.city_suburbs/i)

for (const untouchedPath of [
  'agents/researcher.ts',
  'agents/writer.ts',
  'agents/sender.ts',
  'agents/followup.ts',
]) {
  const source = readFileSync(resolve(root, untouchedPath), 'utf8')
  assert.equal(source.includes('category_suburb_priorities'), false, `${untouchedPath} stays independent`)
}

console.log('Finder category suburb priority checks passed')
