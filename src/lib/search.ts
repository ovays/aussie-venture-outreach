export const SEARCH_DEBOUNCE_MS = 300
export const SEARCH_MAX_LENGTH = 200

export function normalizeSearchTerm(value: string | null | undefined, maxLength = SEARCH_MAX_LENGTH): string {
  if (!Number.isSafeInteger(maxLength) || maxLength < 0) {
    throw new RangeError('maxLength must be a non-negative safe integer')
  }

  return (value ?? '').trim().slice(0, maxLength)
}

export function escapePostgresLikeTerm(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')
}
