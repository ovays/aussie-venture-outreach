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
