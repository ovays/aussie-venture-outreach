import {
  EMAIL_TEMPLATE_TYPES,
  type CategoryEmailTemplateDraft,
  type EmailTemplateType,
  type InitialTemplateReadiness,
  type TemplateField,
  type TemplateValidationError,
} from './email-template-types'

export const USER_PLACEHOLDERS = [
  'business_name',
  'contact_name',
  'category_name',
  'city',
  'website',
] as const

export const SYSTEM_PLACEHOLDERS = [
  'initial_subject',
  'category_reminder',
  'follow_up_3_closing',
  'reactivation_subject',
  'brand_intro',
  'reactivation_context',
  'reactivation_ask',
] as const

export type TemplatePlaceholder = (typeof USER_PLACEHOLDERS)[number] | (typeof SYSTEM_PLACEHOLDERS)[number]

export const SAMPLE_TEMPLATE_VALUES: Record<TemplatePlaceholder, string> = {
  business_name: 'Harbour Escape',
  contact_name: 'Sarah',
  category_name: 'Escape Rooms',
  city: 'Sydney',
  website: 'https://example.com',
  initial_subject: 'Collaboration with Harbour Escape',
  category_reminder: 'We create practical travel content that helps people discover standout local experiences.',
  follow_up_3_closing: 'I wanted to send one final note before I close the loop.',
  reactivation_subject: 'Reconnecting with Harbour Escape',
  brand_intro: 'Aussie Venture helps Australians discover memorable local experiences.',
  reactivation_context: 'I thought the timing might be better now.',
  reactivation_ask: 'Would you be open to revisiting it?',
}

type PlaceholderMatrix = Record<EmailTemplateType, Record<TemplateField, readonly TemplatePlaceholder[]>>

export const ALLOWED_PLACEHOLDERS: PlaceholderMatrix = {
  initial_pitch: {
    subject_template: USER_PLACEHOLDERS,
    body_template: USER_PLACEHOLDERS,
  },
  follow_up_1: {
    subject_template: ['initial_subject'],
    body_template: ['business_name', 'category_reminder'],
  },
  follow_up_2: {
    subject_template: ['initial_subject'],
    body_template: ['business_name', 'category_reminder'],
  },
  follow_up_3: {
    subject_template: ['initial_subject'],
    body_template: ['business_name', 'category_reminder', 'follow_up_3_closing'],
  },
  reactivation: {
    subject_template: ['reactivation_subject'],
    body_template: ['business_name', 'brand_intro', 'reactivation_context', 'reactivation_ask'],
  },
}

const ALL_PLACEHOLDERS = new Set<string>([...USER_PLACEHOLDERS, ...SYSTEM_PLACEHOLDERS])

export const TEMPLATE_STAGE_LABELS: Record<EmailTemplateType, string> = {
  initial_pitch: 'Initial Email',
  follow_up_1: 'Follow-up 1',
  follow_up_2: 'Follow-up 2',
  follow_up_3: 'Follow-up 3',
  reactivation: 'Reactivation',
}

export function emptyTemplateDraft(templateType: EmailTemplateType): CategoryEmailTemplateDraft {
  return { template_type: templateType, subject_template: null, body_template: null }
}

export function emptyTemplateDrafts(): Record<EmailTemplateType, CategoryEmailTemplateDraft> {
  return Object.fromEntries(EMAIL_TEMPLATE_TYPES.map((type) => [type, emptyTemplateDraft(type)])) as Record<EmailTemplateType, CategoryEmailTemplateDraft>
}

export interface StoredTemplateLike {
  category_id: string
  template_type: string
  subject_template: string | null
  body_template: string | null
}

export function templatesForCategory(rows: StoredTemplateLike[]): Record<EmailTemplateType, CategoryEmailTemplateDraft> {
  const drafts = emptyTemplateDrafts()
  for (const row of rows) {
    if (!EMAIL_TEMPLATE_TYPES.includes(row.template_type as EmailTemplateType)) continue
    const type = row.template_type as EmailTemplateType
    drafts[type] = { template_type: type, subject_template: row.subject_template, body_template: row.body_template }
  }
  return drafts
}

export function hydrateCategoryTemplates<T extends { id: string }>(categories: T[], rows: StoredTemplateLike[]) {
  return categories.map((category) => {
    const categoryRows = rows.filter((row) => row.category_id === category.id)
    const templates = templatesForCategory(categoryRows)
    const hasInitialRow = categoryRows.some((row) => row.template_type === 'initial_pitch')
    const initialTemplateReadiness = getInitialTemplateReadiness(hasInitialRow ? templates.initial_pitch : null)
    const templateValidation = Object.fromEntries(EMAIL_TEMPLATE_TYPES.map((type) => [type, validateTemplate(templates[type])])) as Record<EmailTemplateType, TemplateValidationError[]>
    const templateCompleteness = Object.fromEntries(EMAIL_TEMPLATE_TYPES.map((type) => [type, Boolean(
      templates[type].subject_template?.trim() && templates[type].body_template?.trim() && templateValidation[type].length === 0,
    )])) as Record<EmailTemplateType, boolean>
    return { ...category, templates, initialTemplateReadiness, templateValidation, templateCompleteness }
  })
}

function error(field: TemplateField, code: TemplateValidationError['code'], message: string, placeholder?: string): TemplateValidationError {
  return { field, code, message, ...(placeholder ? { placeholder } : {}) }
}

export function validateTemplateField(templateType: EmailTemplateType, field: TemplateField, value: string | null | undefined): TemplateValidationError[] {
  const content = value ?? ''
  const errors: TemplateValidationError[] = []
  const fieldLabel = field === 'subject_template' ? 'Subject' : 'Body'

  if (field === 'subject_template' && /[\r\n]/.test(content)) {
    errors.push(error(field, 'newline', `${fieldLabel} cannot contain newlines.`))
  }

  let index = 0
  while (index < content.length) {
    const open = content.indexOf('{{', index)
    const close = content.indexOf('}}', index)

    if (close !== -1 && (open === -1 || close < open)) {
      errors.push(error(field, 'malformed', `${fieldLabel} contains a closing delimiter without an opening delimiter.`))
      index = close + 2
      continue
    }
    if (open === -1) break

    if (content.slice(index, open).includes('{') || content.slice(index, open).includes('}')) {
      errors.push(error(field, 'malformed', `${fieldLabel} contains malformed double-brace syntax.`))
    }

    const end = content.indexOf('}}', open + 2)
    if (end === -1) {
      errors.push(error(field, 'malformed', `${fieldLabel} contains an unclosed placeholder.`))
      index = content.length
      break
    }

    const rawName = content.slice(open + 2, end)
    if (rawName.length === 0) {
      errors.push(error(field, 'empty_placeholder', `${fieldLabel} contains an empty placeholder.`, '{{}}'))
    } else if (!/^[a-z][a-z0-9_]*$/.test(rawName) || rawName.includes('{') || rawName.includes('}')) {
      errors.push(error(field, 'malformed', `${fieldLabel} contains malformed placeholder {{${rawName}}}.`, `{{${rawName}}}`))
    } else if (!ALLOWED_PLACEHOLDERS[templateType][field].includes(rawName as TemplatePlaceholder)) {
      const code = ALL_PLACEHOLDERS.has(rawName) ? 'wrong_context' : 'unsupported_placeholder'
      const detail = code === 'wrong_context' ? 'is not allowed in this template stage and field' : 'is not supported'
      errors.push(error(field, code, `${fieldLabel} placeholder {{${rawName}}} ${detail}.`, `{{${rawName}}}`))
    }
    index = end + 2
  }

  if (/[{}]/.test(content.slice(index))) {
    errors.push(error(field, 'malformed', `${fieldLabel} contains malformed double-brace syntax.`))
  }

  return errors
}

export function validateTemplate(template: CategoryEmailTemplateDraft): TemplateValidationError[] {
  return [
    ...validateTemplateField(template.template_type, 'subject_template', template.subject_template),
    ...validateTemplateField(template.template_type, 'body_template', template.body_template),
  ]
}

export function getInitialTemplateReadiness(template?: CategoryEmailTemplateDraft | null): InitialTemplateReadiness {
  if (!template) {
    return { ready: false, status: 'missing', errors: [], reasons: ['Initial Email template is missing.'] }
  }

  const errors = validateTemplate({ ...template, template_type: 'initial_pitch' })
  if (!template.subject_template?.trim()) {
    errors.unshift(error('subject_template', 'required', 'Initial Email subject is required.'))
  }
  if (!template.body_template?.trim()) {
    errors.push(error('body_template', 'required', 'Initial Email body is required.'))
  }

  const reasons = [...new Set(errors.map((item) => item.message))]
  return {
    ready: errors.length === 0,
    status: errors.length === 0 ? 'ready' : (template.subject_template == null && template.body_template == null ? 'missing' : 'invalid'),
    errors,
    reasons,
  }
}

export interface RenderedTemplate { subject: string; body: string }
export type RenderTemplateResult = { ok: true; value: RenderedTemplate } | { ok: false; errors: TemplateValidationError[] }

export function renderTemplate(template: CategoryEmailTemplateDraft, values: Partial<Record<TemplatePlaceholder, string>> = SAMPLE_TEMPLATE_VALUES): RenderTemplateResult {
  const errors = validateTemplate(template)
  if (errors.length > 0) return { ok: false, errors }

  const renderField = (field: TemplateField): string => (template[field] ?? '').replace(/{{([a-z][a-z0-9_]*)}}/g, (_match, name: TemplatePlaceholder) => values[name] ?? `{{${name}}}`)
  const subject = renderField('subject_template')
  const body = renderField('body_template')
  const unresolved: TemplateValidationError[] = []
  for (const [field, output] of [['subject_template', subject], ['body_template', body]] as const) {
    const match = output.match(/{{[^}]*}}|{{|}}/)
    if (match) unresolved.push(error(field, 'unresolved', `${field === 'subject_template' ? 'Subject' : 'Body'} still contains unresolved placeholder ${match[0]}.`, match[0]))
  }
  return unresolved.length > 0 ? { ok: false, errors: unresolved } : { ok: true, value: { subject, body } }
}

export function normaliseCategoryName(name: string): string {
  return name.trim().toLocaleLowerCase('en-AU')
}

export function isDuplicateCategoryName(categories: Array<{ id: string; name: string }>, name: string, excludeId?: string): boolean {
  const normalised = normaliseCategoryName(name)
  return categories.some((category) => category.id !== excludeId && normaliseCategoryName(category.name) === normalised)
}

export function mergeTemplateDraft(existing: CategoryEmailTemplateDraft, patch: Partial<Pick<CategoryEmailTemplateDraft, 'subject_template' | 'body_template'>>): CategoryEmailTemplateDraft {
  return {
    ...existing,
    ...(Object.prototype.hasOwnProperty.call(patch, 'subject_template') ? { subject_template: patch.subject_template ?? null } : {}),
    ...(Object.prototype.hasOwnProperty.call(patch, 'body_template') ? { body_template: patch.body_template ?? null } : {}),
  }
}

export interface TemplateModeCategory {
  name: string
  status: 'active' | 'paused'
  initialTemplate: CategoryEmailTemplateDraft | null
}

export interface TemplateModeBlocker { name: string; reasons: string[] }

export function getTemplateModeBlockers(categories: TemplateModeCategory[]): TemplateModeBlocker[] {
  return categories
    .filter((category) => category.status === 'active')
    .map((category) => ({ name: category.name, readiness: getInitialTemplateReadiness(category.initialTemplate) }))
    .filter(({ readiness }) => !readiness.ready)
    .map(({ name, readiness }) => ({ name, reasons: readiness.reasons }))
}

export function shouldBlockCategorySave(input: {
  status: 'active' | 'paused'
  initialEmailMode: 'ai_personalised' | 'template'
  readiness: InitialTemplateReadiness
}): boolean {
  return input.status === 'active' && input.initialEmailMode === 'template' && !input.readiness.ready
}
