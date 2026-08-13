export const EMAIL_TEMPLATE_TYPES = [
  'initial_pitch',
  'follow_up_1',
  'follow_up_2',
  'follow_up_3',
  'reactivation',
] as const

export type EmailTemplateType = (typeof EMAIL_TEMPLATE_TYPES)[number]
export type EmailGenerationSource = 'ai' | 'template'

export interface CategoryEmailTemplate {
  id: string
  category_id: string
  template_type: EmailTemplateType
  subject_template: string | null
  body_template: string | null
  created_at: string
  updated_at: string
}

export type TemplateField = 'subject_template' | 'body_template'

export interface CategoryEmailTemplateDraft {
  template_type: EmailTemplateType
  subject_template: string | null
  body_template: string | null
}

export interface TemplateValidationError {
  field: TemplateField
  code: 'required' | 'newline' | 'malformed' | 'empty_placeholder' | 'unsupported_placeholder' | 'wrong_context' | 'unresolved'
  message: string
  placeholder?: string
}

export interface InitialTemplateReadiness {
  ready: boolean
  status: 'ready' | 'missing' | 'invalid'
  errors: TemplateValidationError[]
  reasons: string[]
}

export interface ManagedCategory {
  id: string
  name: string
  halal_filter: boolean
  cities: 'sydney_only' | 'all' | 'custom'
  custom_cities: string[] | null
  content_type: 'visit' | 'remote' | 'both'
  city_content_types: Record<string, 'visit' | 'remote'> | null
  pitch_template: string | null
  dm_template: string | null
  search_keywords: string[] | null
  use_priority_suburbs: boolean
  status: 'active' | 'paused'
  templates: Record<EmailTemplateType, CategoryEmailTemplateDraft>
  initialTemplateReadiness: InitialTemplateReadiness
  templateValidation: Record<EmailTemplateType, TemplateValidationError[]>
  templateCompleteness: Record<EmailTemplateType, boolean>
}
