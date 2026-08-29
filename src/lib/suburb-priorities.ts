export interface CitySuburbRecord {
  id: string
  city: string
  suburb: string
  active: boolean
  priority: number | null
}

export interface CategorySuburbPriorityRecord {
  city_suburb_id: string
  priority: number
}

export interface SettingsSuburbRow {
  id: string
  suburb: string
  active: boolean
  priority: number
}

export function clampSuburbPriority(priority: number): number {
  return Math.min(10, Math.max(1, Math.round(priority)))
}

export function groupEffectiveSuburbPriorities(
  suburbs: CitySuburbRecord[],
  categoryPriorities?: CategorySuburbPriorityRecord[],
): Record<string, SettingsSuburbRow[]> {
  const customized = categoryPriorities !== undefined && categoryPriorities.length > 0
  const categoryPriorityBySuburb = new Map(
    (categoryPriorities ?? []).map((row) => [row.city_suburb_id, row.priority]),
  )
  const grouped: Record<string, SettingsSuburbRow[]> = {}

  for (const suburb of suburbs) {
    if (!grouped[suburb.city]) grouped[suburb.city] = []
    grouped[suburb.city].push({
      id: suburb.id,
      suburb: suburb.suburb,
      active: suburb.active,
      priority: customized
        ? categoryPriorityBySuburb.get(suburb.id) ?? 1
        : suburb.priority ?? 1,
    })
  }

  return grouped
}
