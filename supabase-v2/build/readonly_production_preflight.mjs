import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) throw new Error('Supabase URL/service-role environment variables are unavailable')

const supabase = createClient(url, key, {
  auth: { autoRefreshToken: false, persistSession: false },
})

async function selectAll(table, columns, configure = (query) => query) {
  const rows = []
  const pageSize = 1000
  for (let from = 0; ; from += pageSize) {
    const query = configure(supabase.from(table).select(columns)).range(from, from + pageSize - 1)
    const { data, error } = await query
    if (error) throw new Error(`${table} read failed: ${error.message}`)
    rows.push(...data)
    if (data.length < pageSize) return rows
  }
}

const normalize = (value) =>
  typeof value === 'string'
    ? value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-AU')
    : ''

const categories = await selectAll('categories', 'id,name')
const nullCategoryLeads = await selectAll(
  'leads',
  'id,category_name,status,source',
  (query) => query.is('category_id', null),
)
const citySuburbs = await selectAll('city_suburbs', 'priority')

const categoriesByName = new Map()
for (const category of categories) {
  const keyName = normalize(category.name)
  const values = categoriesByName.get(keyName) ?? []
  values.push(category)
  categoriesByName.set(keyName, values)
}

// No reviewed alias artifact exists yet. Prompt 5 forbids inventing aliases;
// therefore the approved-alias input is deliberately empty for this preflight.
const reviewedAliases = new Map()

const classifications = { auto_map: 0, alias_map: 0, ambiguous: 0, unmatched: 0 }
const byStatus = {}
const bySource = {}
const unmatchedNames = new Map()

for (const lead of nullCategoryLeads) {
  const normalizedName = normalize(lead.category_name)
  const exact = categoriesByName.get(normalizedName) ?? []
  const aliases = reviewedAliases.get(normalizedName) ?? []
  let classification
  if (exact.length === 1) classification = 'auto_map'
  else if (exact.length > 1) classification = 'ambiguous'
  else if (aliases.length === 1) classification = 'alias_map'
  else if (aliases.length > 1) classification = 'ambiguous'
  else classification = 'unmatched'

  classifications[classification] += 1
  const status = lead.status ?? '(null)'
  const source = lead.source ?? '(null)'
  byStatus[status] ??= { auto_map: 0, alias_map: 0, ambiguous: 0, unmatched: 0 }
  bySource[source] ??= { auto_map: 0, alias_map: 0, ambiguous: 0, unmatched: 0 }
  byStatus[status][classification] += 1
  bySource[source][classification] += 1
  if (classification === 'unmatched') {
    const label = lead.category_name ?? '(null)'
    unmatchedNames.set(label, (unmatchedNames.get(label) ?? 0) + 1)
  }
}

const result = {
  mode: 'READ ONLY (PostgREST SELECT only)',
  category_remediation: {
    category_count: categories.length,
    null_category_leads: nullCategoryLeads.length,
    classifications,
    by_status: byStatus,
    by_source: bySource,
    reviewed_alias_count: reviewedAliases.size,
    unmatched_names: [...unmatchedNames.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .map(([category_name, count]) => ({ category_name, count })),
  },
  city_suburbs_priority: {
    total: citySuburbs.length,
    null: citySuburbs.filter((row) => row.priority == null).length,
    below_1: citySuburbs.filter((row) => row.priority != null && row.priority < 1).length,
    above_10: citySuburbs.filter((row) => row.priority != null && row.priority > 10).length,
  },
}

const classifiedTotal = Object.values(classifications).reduce((sum, count) => sum + count, 0)
if (classifiedTotal !== nullCategoryLeads.length) throw new Error('category classification count conservation failed')

console.log(JSON.stringify(result, null, 2))
