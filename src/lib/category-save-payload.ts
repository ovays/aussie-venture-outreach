import { EMAIL_TEMPLATE_TYPES, type CategoryEmailTemplateDraft, type ManagedCategory } from './email-template-types'

export type CategorySaveDraft = Pick<ManagedCategory,
  | 'name'
  | 'halal_filter'
  | 'cities'
  | 'custom_cities'
  | 'content_type'
  | 'city_content_types'
  | 'pitch_template'
  | 'dm_template'
  | 'search_keywords'
  | 'use_priority_suburbs'
  | 'status'
  | 'templates'
>

function editableTemplates(templates: Record<string, CategoryEmailTemplateDraft>) {
  return Object.fromEntries(EMAIL_TEMPLATE_TYPES.map((type) => [type, {
    subject_template: templates[type].subject_template,
    body_template: templates[type].body_template,
  }]))
}

export function buildCategorySavePayload(category: ManagedCategory | null, draft: CategorySaveDraft) {
  return {
    ...(category ? { id: category.id } : {}),
    name: draft.name,
    halal_filter: draft.halal_filter,
    cities: draft.cities,
    custom_cities: draft.custom_cities,
    content_type: draft.content_type,
    pitch_template: draft.pitch_template,
    dm_template: draft.dm_template,
    search_keywords: draft.search_keywords,
    status: draft.status,
    use_priority_suburbs: draft.use_priority_suburbs,
    city_content_types: draft.city_content_types,
    templates: editableTemplates(draft.templates),
  }
}
