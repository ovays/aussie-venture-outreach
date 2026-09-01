import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolvePagination } from '@/lib/pagination'
import { normalizeSearchTerm } from '@/lib/search'

const FILTERS = new Set([
  'all', 'fu1_due', 'fu2_due', 'fu3_due', 'fu1', 'fu2', 'fu3',
  'fu_due', 'overdue', 'reactivation', 'awaiting_dead', 'dead',
])
const SORT_KEYS = new Set(['next_action_date', 'days_since_initial', 'stage'])

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = request.nextUrl
  const pagination = resolvePagination({
    page: searchParams.get('page'),
    pageSize: searchParams.get('page_size'),
  })
  const requestedFilter = searchParams.get('filter') ?? 'all'
  const requestedSort = searchParams.get('sort') ?? 'next_action_date'
  const sortDir = searchParams.get('dir') === 'desc' ? 'desc' : 'asc'
  const asOfParam = searchParams.get('as_of')
  const asOf = asOfParam && !Number.isNaN(Date.parse(asOfParam))
    ? new Date(asOfParam).toISOString()
    : new Date().toISOString()

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('get_lifecycle_page', {
    p_as_of: asOf,
    p_filter: FILTERS.has(requestedFilter) ? requestedFilter : 'all',
    p_search: normalizeSearchTerm(searchParams.get('search')),
    p_sort_key: SORT_KEYS.has(requestedSort) ? requestedSort : 'next_action_date',
    p_sort_dir: sortDir,
    p_page: pagination.page,
    p_page_size: pagination.pageSize,
  })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ ...data, as_of: asOf })
}
