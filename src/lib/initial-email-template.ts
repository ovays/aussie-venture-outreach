import type { SupabaseClient } from '@supabase/supabase-js'
import { getInitialTemplateReadiness, renderTemplate } from '@/lib/category-email-templates'
import type { CategoryEmailTemplateDraft } from '@/lib/email-template-types'

export type InitialEmailTemplateLead = {
  id: string
  business_name: string
  category_id: string | null
  category_name: string | null
  city: string | null
  website: string | null
  contact_name?: string | null
}

export type TemplateGenerationErrorCode =
  | 'missing_category_id' | 'category_not_found' | 'missing_template'
  | 'empty_subject' | 'empty_body' | 'invalid_template' | 'missing_lead_value'
  | 'unresolved_placeholder' | 'template_load_failed'

export type InitialEmailTemplateResult =
  | { ok: true; subject: string; body: string; categoryId: string; categoryName: string }
  | { ok: false; code: TemplateGenerationErrorCode; reason: string; categoryId: string | null; categoryName: string | null }

const PLACEHOLDER = /{{([a-z][a-z0-9_]*)}}/g

export async function generateInitialEmailFromTemplate(
  supabase: SupabaseClient,
  lead: InitialEmailTemplateLead,
): Promise<InitialEmailTemplateResult> {
  if (!lead.category_id) {
    return { ok: false, code: 'missing_category_id', reason: 'Lead has no category ID.', categoryId: null, categoryName: lead.category_name }
  }

  const [{ data: category, error: categoryError }, { data: row, error: templateError }] = await Promise.all([
    supabase.from('categories').select('id, name').eq('id', lead.category_id).maybeSingle(),
    supabase.from('category_email_templates')
      .select('category_id, template_type, subject_template, body_template')
      .eq('category_id', lead.category_id)
      .eq('template_type', 'initial_pitch')
      .maybeSingle(),
  ])
  if (categoryError || templateError) {
    return { ok: false, code: 'template_load_failed', reason: (categoryError ?? templateError)?.message ?? 'Template lookup failed.', categoryId: lead.category_id, categoryName: lead.category_name }
  }
  if (!category) {
    return { ok: false, code: 'category_not_found', reason: 'The lead category no longer exists.', categoryId: lead.category_id, categoryName: lead.category_name }
  }
  if (!row) {
    return { ok: false, code: 'missing_template', reason: 'This category has no Initial Email template.', categoryId: lead.category_id, categoryName: category.name }
  }

  const template: CategoryEmailTemplateDraft = {
    template_type: 'initial_pitch',
    subject_template: row.subject_template,
    body_template: row.body_template,
  }
  const readiness = getInitialTemplateReadiness(template)
  if (!readiness.ready) {
    const code = !template.subject_template?.trim() ? 'empty_subject' : !template.body_template?.trim() ? 'empty_body' : 'invalid_template'
    return { ok: false, code, reason: readiness.reasons.join(' '), categoryId: lead.category_id, categoryName: category.name }
  }

  const values: Record<string, string | null | undefined> = {
    business_name: lead.business_name,
    contact_name: lead.contact_name,
    category_name: category.name,
    city: lead.city,
    website: lead.website,
  }
  const used = new Set<string>()
  for (const source of [template.subject_template ?? '', template.body_template ?? '']) {
    for (const match of source.matchAll(PLACEHOLDER)) used.add(match[1])
  }
  for (const name of used) {
    if (!values[name]?.trim()) {
      return { ok: false, code: 'missing_lead_value', reason: `Required lead value for {{${name}}} is missing.`, categoryId: lead.category_id, categoryName: category.name }
    }
  }

  const rendered = renderTemplate(template, Object.fromEntries([...used].map((name) => [name, values[name]!.trim()])))
  if (!rendered.ok) {
    return { ok: false, code: rendered.errors.some((item) => item.code === 'unresolved') ? 'unresolved_placeholder' : 'invalid_template', reason: rendered.errors.map((item) => item.message).join(' '), categoryId: lead.category_id, categoryName: category.name }
  }
  const subject = rendered.value.subject.trim()
  const body = rendered.value.body.trim()
  if (!subject) return { ok: false, code: 'empty_subject', reason: 'Rendered subject is empty.', categoryId: lead.category_id, categoryName: category.name }
  if (!body) return { ok: false, code: 'empty_body', reason: 'Rendered body is empty.', categoryId: lead.category_id, categoryName: category.name }
  if (/{{[^}]*}}|{{|}}/.test(`${subject}\n${body}`)) return { ok: false, code: 'unresolved_placeholder', reason: 'Rendered email contains an unresolved placeholder.', categoryId: lead.category_id, categoryName: category.name }
  return { ok: true, subject, body, categoryId: lead.category_id, categoryName: category.name }
}
