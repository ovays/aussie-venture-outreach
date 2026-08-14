export const DEFAULT_PAGE = 1
export const DEFAULT_PAGE_SIZE = 50
export const MAX_PAGE_SIZE = 100

export interface PaginationInput {
  page?: unknown
  pageSize?: unknown
}

export interface PaginationOptions {
  defaultPage?: number
  defaultPageSize?: number
  maxPageSize?: number
}

export interface Pagination {
  page: number
  pageSize: number
}

export interface SupabaseRange {
  from: number
  to: number
}

export interface PaginatedResponse<T> extends Pagination {
  data: T[]
  total: number
  totalPages: number
}

function requirePositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`)
  }
}

function parsePositiveSafeInteger(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : null
  }

  if (typeof value !== 'string') return null

  const normalized = value.trim()
  if (!/^\d+$/.test(normalized)) return null

  const parsed = Number(normalized)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

export function resolvePagination(
  input: PaginationInput = {},
  options: PaginationOptions = {},
): Pagination {
  const defaultPage = options.defaultPage ?? DEFAULT_PAGE
  const defaultPageSize = options.defaultPageSize ?? DEFAULT_PAGE_SIZE
  const maxPageSize = options.maxPageSize ?? MAX_PAGE_SIZE

  requirePositiveSafeInteger(defaultPage, 'defaultPage')
  requirePositiveSafeInteger(defaultPageSize, 'defaultPageSize')
  requirePositiveSafeInteger(maxPageSize, 'maxPageSize')

  if (defaultPageSize > maxPageSize) {
    throw new RangeError('defaultPageSize must not exceed maxPageSize')
  }

  const page = parsePositiveSafeInteger(input.page) ?? defaultPage
  const requestedPageSize = parsePositiveSafeInteger(input.pageSize) ?? defaultPageSize

  return {
    page,
    pageSize: Math.min(requestedPageSize, maxPageSize),
  }
}

export function toSupabaseRange({ page, pageSize }: Pagination): SupabaseRange {
  requirePositiveSafeInteger(page, 'page')
  requirePositiveSafeInteger(pageSize, 'pageSize')

  const from = (page - 1) * pageSize
  const to = from + pageSize - 1

  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to)) {
    throw new RangeError('pagination range exceeds JavaScript safe integer limits')
  }

  return { from, to }
}

export function createPaginatedResponse<T>(
  data: T[],
  pagination: Pagination,
  total: number,
): PaginatedResponse<T> {
  requirePositiveSafeInteger(pagination.page, 'page')
  requirePositiveSafeInteger(pagination.pageSize, 'pageSize')

  if (!Number.isSafeInteger(total) || total < 0) {
    throw new RangeError('total must be a non-negative safe integer')
  }

  return {
    data,
    ...pagination,
    total,
    totalPages: Math.ceil(total / pagination.pageSize),
  }
}
