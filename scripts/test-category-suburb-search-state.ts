import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  CATEGORY_SUBURB_EXHAUSTION_COOLDOWN_MS,
  categorySuburbSearchStateKey,
  indexCategorySuburbSearchStates,
  isCategorySuburbCoolingDown,
  isCategorySuburbEligible,
  type CategorySuburbSearchState,
} from '../src/lib/category-suburb-search-state'

const now = new Date('2026-08-30T00:00:00.000Z')
const ago = (milliseconds: number) => new Date(now.getTime() - milliseconds).toISOString()

assert.equal(isCategorySuburbEligible(undefined, now), true, 'no state row is eligible')

const recentExhaustion = { exhausted_at: ago(CATEGORY_SUBURB_EXHAUSTION_COOLDOWN_MS - 1) }
assert.equal(isCategorySuburbCoolingDown(recentExhaustion, now), true)
assert.equal(isCategorySuburbEligible(recentExhaustion, now), false, 'less than seven days is ineligible')

const oldExhaustion = { exhausted_at: ago(CATEGORY_SUBURB_EXHAUSTION_COOLDOWN_MS + 1) }
assert.equal(isCategorySuburbEligible(oldExhaustion, now), true, 'more than seven days is eligible')

const exactBoundary = { exhausted_at: ago(CATEGORY_SUBURB_EXHAUSTION_COOLDOWN_MS) }
assert.equal(isCategorySuburbCoolingDown(exactBoundary, now), false)
assert.equal(isCategorySuburbEligible(exactBoundary, now), true, 'exactly seven days is eligible')

const states: CategorySuburbSearchState[] = [
  {
    category_id: 'halal-restaurants',
    city_suburb_id: 'lakemba',
    last_searched_at: ago(60_000),
    exhausted_at: ago(60_000),
  },
  {
    category_id: 'halal-cafes',
    city_suburb_id: 'lakemba',
    last_searched_at: ago(60_000),
    exhausted_at: null,
  },
  {
    category_id: 'halal-restaurants',
    city_suburb_id: 'auburn',
    last_searched_at: ago(60_000),
    exhausted_at: null,
  },
]
const indexedStates = indexCategorySuburbSearchStates(states)
const stateFor = (categoryId: string, citySuburbId: string) => (
  indexedStates.get(categorySuburbSearchStateKey(categoryId, citySuburbId))
)

assert.equal(isCategorySuburbEligible(stateFor('halal-restaurants', 'lakemba'), now), false)
assert.equal(isCategorySuburbEligible(stateFor('halal-cafes', 'lakemba'), now), true, 'same suburb is independent by category')
assert.equal(isCategorySuburbEligible(stateFor('halal-restaurants', 'auburn'), now), true, 'same category is independent by suburb')

const root = resolve(__dirname, '..')
const migration = readFileSync(resolve(root, 'supabase/migrations/042_category_suburb_search_state.sql'), 'utf8')
const priorityMigration = readFileSync(resolve(root, 'supabase/migrations/041_category_suburb_priorities.sql'), 'utf8')

assert.match(migration, /UNIQUE \(category_id, city_suburb_id\)/)
assert.match(migration, /REFERENCES public\.categories\(id\) ON DELETE CASCADE/)
assert.match(migration, /REFERENCES public\.city_suburbs\(id\) ON DELETE CASCADE/)
assert.match(migration, /last_searched_at TIMESTAMPTZ/)
assert.match(migration, /exhausted_at TIMESTAMPTZ/)
assert.doesNotMatch(migration, /\b(?:INSERT|UPDATE|DELETE)\s+(?:INTO|FROM)?\s*public\.category_suburb_priorities\b/i)
assert.doesNotMatch(migration, /INSERT\s+INTO\s+public\.category_suburb_search_state/i, 'migration has no seed/backfill')
assert.doesNotMatch(migration, /FROM\s+public\.(?:categories|city_suburbs)/i, 'migration has no combination backfill')
assert.match(priorityMigration, /priority INTEGER NOT NULL CHECK \(priority BETWEEN 1 AND 10\)/, 'priority storage is unchanged')

const finder = readFileSync(resolve(root, 'agents/finder.ts'), 'utf8')
assert.equal(finder.includes(".from('category_suburb_search_state')"), true, 'Finder bulk-loads and upserts state')
assert.equal(finder.includes('resolveFinderCooldownEligibility'), true, 'Finder filters using the cooldown helper')
assert.equal(finder.includes('CATEGORY_SUBURBS_COOLING_DOWN'), true, 'Finder exposes the all-cooled category skip')

console.log('Category/suburb search state tests passed')
