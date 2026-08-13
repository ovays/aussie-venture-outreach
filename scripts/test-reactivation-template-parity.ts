import assert from 'node:assert/strict'
import { writeReactivationEmail } from '@/ai/workflows'
import { getReactivationFocus } from '@/lib/category-copy'
import { normalizeContentType } from '@/lib/content-type'
import { generateStoredReactivation } from '@/lib/stored-sequence-templates'
import {
  brandIntroOptions,
  INITIAL_SIGN_OFF,
  pickVariant,
  REACTIVATION_ASKS,
  reactivationContextFor,
  reactivationSubjectFor,
} from '@/lib/email-voice'

type Row = Record<string, unknown>
class Query {
  private filters: Array<[string, unknown]> = []
  constructor(private rows: Row[]) {}
  select() { return this }
  eq(key: string, value: unknown) { this.filters.push([key, value]); return this }
  async maybeSingle() { return { data: this.rows.find((row) => this.filters.every(([key, value]) => row[key] === value)) ?? null, error: null } }
}
const client = (rows: Row[]) => ({ from: () => new Query(rows) }) as never

const validTemplate = {
  category_id: 'cat-valid', template_type: 'reactivation', subject_template: '{{reactivation_subject}}',
  body_template: "Hey {{business_name}},\n\n{{brand_intro}}\n\nI emailed you about a collab a few months back and never heard anything. {{reactivation_context}}\n\n{{reactivation_ask}}\n\nCheers,\nOwais\nAussie Venture\naussieventure.com\ninstagram.com/aussie.venture",
}
const invalidTemplate = { category_id: 'cat-invalid', template_type: 'reactivation', subject_template: '', body_template: '{{unknown}}' }

const cases = [
  { business_name: 'Harbour Escape', category: 'Escape Rooms', suburb: 'Sydney', city: 'Sydney', content_type: 'visit' },
  { business_name: 'Adventure Out', category: 'Tour Operators', suburb: 'Fremantle', city: 'Perth', content_type: 'remote' },
  { business_name: 'Luxe Lash Studio', category: 'Beauty / Lash Studios', suburb: 'Bondi', city: 'Sydney', content_type: 'visit' },
  { business_name: 'Southern Trails', category: 'Hotels', suburb: 'Hobart', city: 'Hobart', content_type: 'remote' },
]

function expectedReactivation(item: (typeof cases)[number]) {
  const contentType = normalizeContentType(item.content_type)
  const intro = brandIntroOptions(contentType)[0]
  const subject = reactivationSubjectFor(item.business_name)
  const context = reactivationContextFor(
    item.business_name,
    getReactivationFocus(item.category, contentType),
  )
  const ask = pickVariant(REACTIVATION_ASKS, item.business_name, 'reactivation-ask')
  const body = `Hey ${item.business_name},\n\n${intro}\n\nI emailed you about a collab a few months back and never heard anything. ${context}\n\n${ask}\n\n${INITIAL_SIGN_OFF}`

  assert.equal(body.slice(-(`\n\n${INITIAL_SIGN_OFF}`.length)), `\n\n${INITIAL_SIGN_OFF}`, `${item.business_name}: exact full sign-off and preceding spacing are retained`)
  return { subject, body }
}

async function main() {
  for (const item of cases) {
    const expected = expectedReactivation(item)
    const normalizedContentType = normalizeContentType(item.content_type)
    assert.equal(
      expected.body.split('\n\n')[1],
      brandIntroOptions(normalizedContentType)[0],
      `${item.business_name}: expected output uses the first ${normalizedContentType} intro`,
    )
    const legacy = await writeReactivationEmail(item)
    const stored = await generateStoredReactivation(client([validTemplate]), 'cat-valid', item.business_name, item.category, item.content_type)
    assert.deepEqual(legacy, expected, `${item.business_name}: writeReactivationEmail matches the independent Prompt 2 formula`)
    assert.deepEqual(stored, expected, `${item.business_name}: stored subject and complete body match the independent Prompt 2 formula`)
  }

  for (const [label, rows, categoryId] of [
    ['missing', [], 'cat-missing'],
    ['invalid', [invalidTemplate], 'cat-invalid'],
  ] as const) {
    for (const item of cases) {
      const expected = expectedReactivation(item)
      const fallback = await generateStoredReactivation(client([...rows]), categoryId, item.business_name, item.category, item.content_type)
      assert.deepEqual(fallback, expected, `${label} template fallback preserves exact ${item.content_type} Prompt 2 output`)
    }
  }

  console.log('Stored Reactivation parity checks passed')
}

main().catch((error) => { console.error(error); process.exit(1) })
