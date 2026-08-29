import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  hasCategorySuburbReachedExhaustion,
  isFinderCategoryRemoteOnly,
  recordCategorySuburbQueryOutcome,
  resolveFinderCooldownEligibility,
  type CategorySuburbExhaustionProgress,
  type FinderLocation,
} from '../agents/finder'
import {
  CATEGORY_SUBURB_EXHAUSTION_COOLDOWN_MS,
  CategorySuburbSameRunCooldown,
  buildExhaustedUpsert,
  buildLastSearchedUpsert,
  categorySuburbSearchStateKey,
  indexCategorySuburbSearchStates,
  type CategorySuburbSearchState,
} from '../src/lib/category-suburb-search-state'

const now = new Date('2026-08-30T00:00:00.000Z')
const ago = (milliseconds: number) => new Date(now.getTime() - milliseconds).toISOString()
const locations: FinderLocation[] = [
  { citySuburbId: 'lakemba', suburb: 'Lakemba', city: 'Sydney', state: 'NSW', priority: 10 },
  { citySuburbId: 'auburn', suburb: 'Auburn', city: 'Sydney', state: 'NSW', priority: 9 },
]

const states: CategorySuburbSearchState[] = [
  {
    category_id: 'halal-restaurants',
    city_suburb_id: 'lakemba',
    last_searched_at: ago(60_000),
    exhausted_at: ago(CATEGORY_SUBURB_EXHAUSTION_COOLDOWN_MS - 1),
  },
]
const indexedStates = indexCategorySuburbSearchStates(states)

const filtered = resolveFinderCooldownEligibility(
  'halal-restaurants',
  locations,
  indexedStates,
  { remoteOnly: false, persistenceAvailable: true },
  now
)
assert.deepEqual(filtered.eligible.map((location) => location.citySuburbId), ['auburn'])
assert.equal(filtered.excludedCount, 1, 'priority 10 cooling down is excluded')
assert.equal(filtered.allCoolingDown, false, 'priority 9 remains searchable')
assert.deepEqual(locations.map((location) => location.priority), [10, 9], 'cooldown never changes priority')

const otherCategory = resolveFinderCooldownEligibility(
  'halal-cafes',
  locations,
  indexedStates,
  { remoteOnly: false, persistenceAvailable: true },
  now
)
assert.equal(otherCategory.eligible.length, 2, 'same suburb has independent state in another category')

const sameCategoryOtherSuburb = indexedStates.get(
  categorySuburbSearchStateKey('halal-restaurants', 'auburn')
)
assert.equal(sameCategoryOtherSuburb, undefined, 'same category has independent state in another suburb')

const allCoolingStates = indexCategorySuburbSearchStates<CategorySuburbSearchState>([
  ...states,
  {
    category_id: 'halal-restaurants',
    city_suburb_id: 'auburn',
    last_searched_at: ago(60_000),
    exhausted_at: ago(60_000),
  },
])
const allCooling = resolveFinderCooldownEligibility(
  'halal-restaurants',
  locations,
  allCoolingStates,
  { remoteOnly: false, persistenceAvailable: true },
  now
)
assert.equal(allCooling.allCoolingDown, true)
assert.equal(allCooling.eligible.length, 0, 'all-cooled categories are skipped without fallback reset')

const expiredState = indexCategorySuburbSearchStates<CategorySuburbSearchState>([{
  ...states[0],
  exhausted_at: ago(CATEGORY_SUBURB_EXHAUSTION_COOLDOWN_MS),
}])
assert.equal(
  resolveFinderCooldownEligibility(
    'halal-restaurants',
    locations,
    expiredState,
    { remoteOnly: false, persistenceAvailable: true },
    now
  ).eligible.length,
  2,
  'exactly seven days restores eligibility naturally'
)

const sameRun = new CategorySuburbSameRunCooldown(15)
sameRun.add('halal-restaurants', 'lakemba')
assert.equal(sameRun.has('halal-restaurants', 'lakemba'), true)
assert.equal(sameRun.has('halal-cafes', 'lakemba'), false, 'same-run cooldown is category scoped')
assert.equal(sameRun.has('halal-restaurants', 'auburn'), false, 'same-run cooldown is suburb scoped')

const searchedAt = now.toISOString()
assert.deepEqual(
  buildLastSearchedUpsert('halal-restaurants', 'lakemba', searchedAt),
  {
    category_id: 'halal-restaurants',
    city_suburb_id: 'lakemba',
    last_searched_at: searchedAt,
  },
  'search upsert targets the exact pair'
)
assert.deepEqual(
  buildExhaustedUpsert('halal-restaurants', 'lakemba', searchedAt),
  {
    category_id: 'halal-restaurants',
    city_suburb_id: 'lakemba',
    exhausted_at: searchedAt,
  },
  'exhaustion upsert targets the exact pair'
)
assert.equal('priority' in buildExhaustedUpsert('halal-restaurants', 'lakemba', searchedAt), false)

const progress: CategorySuburbExhaustionProgress = {
  exhaustedQueries: new Set(),
  producedNewLead: false,
}
const requiredQueries = new Set(['query one', 'query two'])
recordCategorySuburbQueryOutcome(progress, 'query one', true, 0)
assert.equal(hasCategorySuburbReachedExhaustion(progress, requiredQueries), false, 'one query cannot exhaust a pair')
recordCategorySuburbQueryOutcome(progress, 'query two', true, 0)
assert.equal(hasCategorySuburbReachedExhaustion(progress, requiredQueries), true, 'all explicit terminal queries exhaust a pair')

const productiveProgress: CategorySuburbExhaustionProgress = {
  exhaustedQueries: new Set(),
  producedNewLead: false,
}
recordCategorySuburbQueryOutcome(productiveProgress, 'query one', true, 1)
recordCategorySuburbQueryOutcome(productiveProgress, 'query two', true, 0)
assert.equal(hasCategorySuburbReachedExhaustion(productiveProgress, requiredQueries), false, 'productive pairs are not exhausted')

const remoteCategory = {
  name: 'Remote Sponsorships',
  contentType: 'remote',
  cityContentTypes: null,
}
assert.equal(isFinderCategoryRemoteOnly(remoteCategory, ['Sydney', 'Melbourne']), true)
const remoteEligibility = resolveFinderCooldownEligibility(
  'halal-restaurants',
  locations,
  allCoolingStates,
  { remoteOnly: true, persistenceAvailable: true },
  now
)
assert.equal(remoteEligibility.eligible.length, locations.length, 'remote flow bypasses suburb state')

const readFailureFallback = resolveFinderCooldownEligibility(
  'halal-restaurants',
  locations,
  allCoolingStates,
  { remoteOnly: false, persistenceAvailable: false },
  now
)
assert.equal(readFailureFallback.eligible.length, locations.length, 'state read failure preserves Finder eligibility')

const finderSource = readFileSync(resolve(__dirname, '..', 'agents/finder.ts'), 'utf8')
assert.match(finderSource, /\.from\('exhausted_queries'\)\.upsert\(/, 'query-level exhaustion remains intact')
assert.match(finderSource, /CATEGORY_SUBURBS_COOLING_DOWN/, 'all-cooled category has structured logging')
assert.match(finderSource, /onConflict: 'category_id,city_suburb_id'/, 'state writes use the composite key')

console.log('Finder category/suburb cooldown integration checks passed')
