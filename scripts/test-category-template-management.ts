import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  ALLOWED_PLACEHOLDERS,
  SAMPLE_TEMPLATE_VALUES,
  SYSTEM_PLACEHOLDERS,
  USER_PLACEHOLDERS,
  emptyTemplateDraft,
  emptyTemplateDrafts,
  getInitialTemplateReadiness,
  getTemplateModeBlockers,
  isDuplicateCategoryName,
  mergeTemplateDraft,
  renderTemplate,
  shouldBlockCategorySave,
  validateTemplate,
  validateTemplateField,
} from '../src/lib/category-email-templates'
import { isInitialEmailMode, SETTINGS_DEFAULTS } from '../src/lib/settingsDefaults'
import { EMAIL_TEMPLATE_TYPES, type CategoryEmailTemplateDraft, type EmailTemplateType, type ManagedCategory } from '../src/lib/email-template-types'
import { updateCategorySchema } from '../src/lib/category-api-schema'
import { buildCategorySavePayload } from '../src/lib/category-save-payload'

const root = resolve(__dirname, '..')
const initial = (subject: string | null, body: string | null): CategoryEmailTemplateDraft => ({ template_type: 'initial_pitch', subject_template: subject, body_template: body })

for (const placeholder of USER_PLACEHOLDERS) {
  assert.equal(validateTemplate(initial(`Hello {{${placeholder}}}`, `Body {{${placeholder}}}`)).length, 0, `Initial Email supports ${placeholder}`)
}
for (const placeholder of SYSTEM_PLACEHOLDERS) {
  assert.equal(validateTemplateField('initial_pitch', 'body_template', `{{${placeholder}}}`)[0]?.code, 'wrong_context', `Initial Email rejects ${placeholder}`)
}

const migratedValid: Array<[EmailTemplateType, 'subject_template' | 'body_template', string]> = [
  ['follow_up_1', 'subject_template', '{{initial_subject}}'],
  ['follow_up_1', 'body_template', '{{business_name}} {{category_reminder}}'],
  ['follow_up_2', 'subject_template', '{{initial_subject}}'],
  ['follow_up_2', 'body_template', '{{business_name}} {{category_reminder}}'],
  ['follow_up_3', 'subject_template', '{{initial_subject}}'],
  ['follow_up_3', 'body_template', '{{business_name}} {{follow_up_3_closing}} {{category_reminder}}'],
  ['reactivation', 'subject_template', '{{reactivation_subject}}'],
  ['reactivation', 'body_template', '{{business_name}} {{brand_intro}} {{reactivation_context}} {{reactivation_ask}}'],
]
for (const [type, field, value] of migratedValid) assert.deepEqual(validateTemplateField(type, field, value), [])

assert.equal(validateTemplateField('initial_pitch', 'body_template', '{{made_up}}')[0]?.code, 'unsupported_placeholder')
for (const malformed of ['{{business_name}', '{business_name}}', '{{}}', '{{ business_name }}', 'business_name}']) {
  assert.ok(validateTemplateField('initial_pitch', 'body_template', malformed).length > 0, `Reject malformed ${malformed}`)
}
assert.equal(validateTemplateField('initial_pitch', 'subject_template', 'Hello\nthere')[0]?.code, 'newline')
assert.deepEqual(validateTemplateField('initial_pitch', 'body_template', '{{business_name}} {{business_name}}'), [])

assert.equal(getInitialTemplateReadiness(null).status, 'missing')
assert.equal(getInitialTemplateReadiness(initial(' ', 'Body')).ready, false)
assert.equal(getInitialTemplateReadiness(initial('Subject', ' ')).ready, false)
const ready = getInitialTemplateReadiness(initial('Hello {{business_name}}', 'Hi {{contact_name}} in {{city}} — {{website}}'))
assert.equal(ready.ready, true)

const rendered = renderTemplate(initial('Hello {{business_name}}', 'Hi {{contact_name}} from {{category_name}} in {{city}}: {{website}}'))
assert.equal(rendered.ok, true)
if (rendered.ok) {
  assert.equal(rendered.value.subject, 'Hello Harbour Escape')
  assert.match(rendered.value.body, /Sarah.*Escape Rooms.*Sydney.*https:\/\/example\.com/)
  assert.doesNotMatch(rendered.value.body, /{{/)
}
const unresolved = renderTemplate(initial('{{business_name}}', 'Hi {{contact_name}}'), { business_name: 'Harbour Escape' })
assert.equal(unresolved.ok, false)
if (!unresolved.ok) assert.equal(unresolved.errors[0]?.code, 'unresolved')
assert.equal(Object.keys(SAMPLE_TEMPLATE_VALUES).length, USER_PLACEHOLDERS.length + SYSTEM_PLACEHOLDERS.length)

const categories = [{ id: '1', name: 'Escape Rooms' }, { id: '2', name: 'Hotels' }]
assert.equal(isDuplicateCategoryName(categories, ' escape rooms '), true)
assert.equal(isDuplicateCategoryName(categories, 'ESCAPE ROOMS'), true)
assert.equal(isDuplicateCategoryName(categories, ' Escape Rooms ', '1'), false)
const existing = { template_type: 'follow_up_1' as const, subject_template: 'Keep me', body_template: 'Old body' }
assert.deepEqual(mergeTemplateDraft(existing, { body_template: 'New body' }), { ...existing, body_template: 'New body' })
assert.deepEqual(mergeTemplateDraft(existing, {}), existing)

assert.equal(shouldBlockCategorySave({ status: 'active', initialEmailMode: 'ai_personalised', readiness: getInitialTemplateReadiness(null) }), false, 'new active + AI + missing is allowed')
assert.equal(shouldBlockCategorySave({ status: 'active', initialEmailMode: 'ai_personalised', readiness: getInitialTemplateReadiness(null) }), false, 'existing active + AI + missing is allowed')
assert.equal(shouldBlockCategorySave({ status: 'active', initialEmailMode: 'template', readiness: getInitialTemplateReadiness(null) }), true, 'new active + Template + missing is blocked')
assert.equal(shouldBlockCategorySave({ status: 'active', initialEmailMode: 'template', readiness: getInitialTemplateReadiness(null) }), true, 'existing active + Template + missing is blocked')
assert.equal(shouldBlockCategorySave({ status: 'paused', initialEmailMode: 'ai_personalised', readiness: getInitialTemplateReadiness(null) }), false, 'paused + AI + missing is allowed')
assert.equal(shouldBlockCategorySave({ status: 'paused', initialEmailMode: 'template', readiness: getInitialTemplateReadiness(null) }), false, 'paused + Template + missing is allowed')
assert.equal(shouldBlockCategorySave({ status: 'active', initialEmailMode: 'template', readiness: ready }), false, 'active + Template + valid is allowed')

const blockers = getTemplateModeBlockers([
  { name: 'Ready', status: 'active', initialTemplate: initial('Subject', 'Body') },
  { name: 'Missing', status: 'active', initialTemplate: null },
  { name: 'Invalid', status: 'active', initialTemplate: initial('{{initial_subject}}', 'Body') },
  { name: 'Paused', status: 'paused', initialTemplate: null },
])
assert.deepEqual(blockers.map((item) => item.name), ['Missing', 'Invalid'])

assert.equal(SETTINGS_DEFAULTS.initial_email_mode.value, 'ai_personalised')
assert.equal(isInitialEmailMode('ai_personalised'), true)
assert.equal(isInitialEmailMode('template'), true)
assert.equal(isInitialEmailMode('invalid'), false)

const enrichedCategory: ManagedCategory & { created_at: string; updated_at: string } = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Mini Golf',
  halal_filter: false,
  cities: 'all',
  custom_cities: [],
  content_type: 'both',
  city_content_types: {},
  pitch_template: 'Pitch',
  dm_template: 'DM',
  search_keywords: ['mini golf'],
  use_priority_suburbs: true,
  status: 'active',
  templates: emptyTemplateDrafts(),
  initialTemplateReadiness: getInitialTemplateReadiness(null),
  templateValidation: Object.fromEntries(EMAIL_TEMPLATE_TYPES.map((type) => [type, []])) as unknown as ManagedCategory['templateValidation'],
  templateCompleteness: Object.fromEntries(EMAIL_TEMPLATE_TYPES.map((type) => [type, false])) as unknown as ManagedCategory['templateCompleteness'],
  created_at: '2026-08-01T00:00:00.000Z',
  updated_at: '2026-08-02T00:00:00.000Z',
}
const categorySavePayload = buildCategorySavePayload(enrichedCategory, { ...enrichedCategory, name: 'Mini Golf Sydney' })
assert.equal(updateCategorySchema.safeParse(categorySavePayload).success, true, 'An edited enriched GET category produces a valid PATCH payload')
assert.deepEqual(Object.keys(categorySavePayload).sort(), [
  'cities', 'city_content_types', 'content_type', 'custom_cities', 'dm_template', 'halal_filter', 'id', 'name',
  'pitch_template', 'search_keywords', 'status', 'templates', 'use_priority_suburbs',
].sort(), 'PATCH contains only fields accepted by the category update schema')
assert.deepEqual(categorySavePayload.templates.initial_pitch, { subject_template: null, body_template: null }, 'Template persistence strips hydrated template metadata')
assert.equal('initialTemplateReadiness' in categorySavePayload, false)
assert.equal('templateValidation' in categorySavePayload, false)
assert.equal('templateCompleteness' in categorySavePayload, false)
assert.equal('created_at' in categorySavePayload, false)
assert.equal('updated_at' in categorySavePayload, false)
assert.equal(updateCategorySchema.safeParse({ ...categorySavePayload, templates: enrichedCategory.templates }).success, false, 'Hydrated template_type metadata reproduces the original validation failure')
assert.equal(updateCategorySchema.safeParse({ ...categorySavePayload, custom_cities: [] }).success, true, 'Empty custom cities are valid for all-cities categories')

const settingsRoute = readFileSync(resolve(root, 'src/app/api/settings/route.ts'), 'utf8')
const categoriesRoute = readFileSync(resolve(root, 'src/app/api/categories/route.ts'), 'utf8')
const utilitySource = readFileSync(resolve(root, 'src/lib/category-email-templates.ts'), 'utf8')
const categoriesTableSource = readFileSync(resolve(root, 'src/components/settings/CategoriesTable.tsx'), 'utf8')
const systemSettingsSource = readFileSync(resolve(root, 'src/components/settings/SystemSettings.tsx'), 'utf8')
assert.doesNotMatch(settingsRoute, /from\(['"]emails['"]\)/, 'Changing mode must not read or alter emails')
assert.doesNotMatch(categoriesRoute, /from\(['"]emails['"]\)/, 'Category template management must not alter emails')
assert.doesNotMatch(utilitySource, /openai|anthropic|gemini|AIProvider|writeOutreachEmail/i, 'Template validation and rendering have no AI dependency')
assert.match(categoriesRoute, /requireApiAdmin/)
assert.match(settingsRoute, /requireApiAdmin/)
assert.doesNotMatch(categoriesRoute, /status:\s*['"]paused['"]/, 'Existing active categories are never automatically paused')
assert.match(categoriesRoute, /const mode = await currentInitialMode\(supabase\)[\s\S]*shouldBlockCategorySave/, 'New category activation checks the saved mode')
assert.match(categoriesTableSource, /{modalOpen && \([\s\S]*<CategoryModal/, 'Closing the category modal unmounts and resets its local state')
assert.match(categoriesTableSource, /category-readiness-changed/, 'Category saves and status changes publish a readiness refresh')
assert.match(systemSettingsSource, /fetch\('\/api\/categories'\)[\s\S]*addEventListener\('category-readiness-changed'/, 'Settings refreshes blockers after category changes')
assert.match(systemSettingsSource, /if \(key === 'initial_email_mode'\) setModeBlockers\(\[\]\)/, 'A successful authoritative mode save clears stale blockers')

for (const [type, fields] of Object.entries(ALLOWED_PLACEHOLDERS)) {
  assert.ok(fields.subject_template.length + fields.body_template.length > 0, `${type} has a scoped placeholder matrix`)
}

console.log('Category template management checks passed')
