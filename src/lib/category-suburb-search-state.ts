const DAY_MS = 24 * 60 * 60 * 1000

export const CATEGORY_SUBURB_EXHAUSTION_COOLDOWN_MS = 7 * DAY_MS

export interface CategorySuburbSearchState {
  category_id: string
  city_suburb_id: string
  last_searched_at: string | null
  exhausted_at: string | null
}

export interface CategorySuburbStateLocation {
  citySuburbId: string | null
}

export interface CategorySuburbEligibilityResult<T> {
  eligible: T[]
  excludedCount: number
  allCoolingDown: boolean
}

export function categorySuburbSearchStateKey(categoryId: string, citySuburbId: string): string {
  return `${categoryId}:${citySuburbId}`
}

export function indexCategorySuburbSearchStates<T extends CategorySuburbSearchState>(
  states: readonly T[]
): Map<string, T> {
  return new Map(states.map((state) => [
    categorySuburbSearchStateKey(state.category_id, state.city_suburb_id),
    state,
  ]))
}

export function isCategorySuburbCoolingDown(
  state: Pick<CategorySuburbSearchState, 'exhausted_at'> | null | undefined,
  now: Date = new Date(),
  cooldownMs: number = CATEGORY_SUBURB_EXHAUSTION_COOLDOWN_MS
): boolean {
  if (!state?.exhausted_at) return false

  const exhaustedAtMs = Date.parse(state.exhausted_at)
  if (!Number.isFinite(exhaustedAtMs)) return false

  return now.getTime() < exhaustedAtMs + cooldownMs
}

export function isCategorySuburbEligible(
  state: Pick<CategorySuburbSearchState, 'exhausted_at'> | null | undefined,
  now: Date = new Date(),
  cooldownMs: number = CATEGORY_SUBURB_EXHAUSTION_COOLDOWN_MS
): boolean {
  return !isCategorySuburbCoolingDown(state, now, cooldownMs)
}

export function filterEligibleCategorySuburbs<T extends CategorySuburbStateLocation>(
  categoryId: string,
  locations: readonly T[],
  statesByKey: ReadonlyMap<string, Pick<CategorySuburbSearchState, 'exhausted_at'>>,
  now: Date = new Date()
): CategorySuburbEligibilityResult<T> {
  const eligible = locations.filter((location) => (
    location.citySuburbId == null
      || isCategorySuburbEligible(
        statesByKey.get(categorySuburbSearchStateKey(categoryId, location.citySuburbId)),
        now
      )
  ))

  return {
    eligible,
    excludedCount: locations.length - eligible.length,
    allCoolingDown: locations.length > 0 && eligible.length === 0,
  }
}

export function buildLastSearchedUpsert(
  categoryId: string,
  citySuburbId: string,
  searchedAt: string
): Pick<CategorySuburbSearchState, 'category_id' | 'city_suburb_id' | 'last_searched_at'> {
  return {
    category_id: categoryId,
    city_suburb_id: citySuburbId,
    last_searched_at: searchedAt,
  }
}

export function buildExhaustedUpsert(
  categoryId: string,
  citySuburbId: string,
  exhaustedAt: string
): Pick<CategorySuburbSearchState, 'category_id' | 'city_suburb_id' | 'exhausted_at'> {
  return {
    category_id: categoryId,
    city_suburb_id: citySuburbId,
    exhausted_at: exhaustedAt,
  }
}

/** Short-lived duplicate avoidance only; persistent exhaustion remains timestamp based. */
export class CategorySuburbSameRunCooldown {
  private readonly queue: string[] = []
  private readonly keys = new Set<string>()

  constructor(private readonly maxSize: number) {}

  has(categoryId: string, citySuburbId: string | null): boolean {
    return citySuburbId != null
      && this.keys.has(categorySuburbSearchStateKey(categoryId, citySuburbId))
  }

  add(categoryId: string, citySuburbId: string | null): void {
    if (citySuburbId == null) return

    const key = categorySuburbSearchStateKey(categoryId, citySuburbId)
    if (this.keys.has(key)) return

    this.keys.add(key)
    this.queue.push(key)
    if (this.queue.length > this.maxSize) {
      this.keys.delete(this.queue.shift()!)
    }
  }

  get size(): number {
    return this.queue.length
  }
}
