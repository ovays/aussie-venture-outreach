import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { isAuthErrorResponse, requireApiAdmin, requireApiUser } from '@/lib/auth'
import {
  emptyTemplateDrafts,
  getInitialTemplateReadiness,
  hydrateCategoryTemplates,
  isDuplicateCategoryName,
  mergeTemplateDraft,
  shouldBlockCategorySave,
  templatesForCategory,
} from '@/lib/category-email-templates'
import { EMAIL_TEMPLATE_TYPES, type EmailTemplateType } from '@/lib/email-template-types'

const categoryFieldsSchema = z.object({
  name: z.string().trim().min(1, 'Category name is required').optional(),
  halal_filter: z.boolean().optional(),
  cities: z.enum(['sydney_only', 'all', 'custom']).optional(),
  custom_cities: z.array(z.string()).nullable().optional(),
  content_type: z.enum(['visit', 'remote', 'both']).optional(),
  city_content_types: z.record(z.string(), z.enum(['visit', 'remote'])).nullable().optional(),
  pitch_template: z.string().nullable().optional(),
  dm_template: z.string().nullable().optional(),
  search_keywords: z.array(z.string()).nullable().optional(),
  use_priority_suburbs: z.boolean().optional(),
  status: z.enum(['active', 'paused']).optional(),
})

const templatePatchSchema = z.object({
  subject_template: z.string().nullable().optional(),
  body_template: z.string().nullable().optional(),
}).strict()

const templatesSchema = z.object({
  initial_pitch: templatePatchSchema.optional(),
  follow_up_1: templatePatchSchema.optional(),
  follow_up_2: templatePatchSchema.optional(),
  follow_up_3: templatePatchSchema.optional(),
  reactivation: templatePatchSchema.optional(),
}).strict()

const createSchema = categoryFieldsSchema.extend({
  name: z.string().trim().min(1, 'Category name is required'),
  templates: templatesSchema.optional(),
})
const updateSchema = categoryFieldsSchema.extend({ id: z.string().uuid(), templates: templatesSchema.optional() })

type SupabaseClient = Awaited<ReturnType<typeof createClient>>
type CategoryRow = Record<string, unknown> & { id: string; name: string; status: 'active' | 'paused' }

async function fetchCategoriesAndTemplates(supabase: SupabaseClient) {
  const [{ data: categories, error: categoryError }, { data: templates, error: templateError }] = await Promise.all([
    supabase.from('categories').select('*').order('name'),
    supabase.from('category_email_templates').select('*'),
  ])
  return {
    categories: (categories ?? []) as CategoryRow[],
    templates: (templates ?? []) as Array<Record<string, unknown>>,
    error: categoryError ?? templateError,
  }
}

async function currentInitialMode(supabase: SupabaseClient): Promise<string> {
  const { data } = await supabase.from('settings').select('value').eq('key', 'initial_email_mode').maybeSingle()
  return data?.value ?? 'ai_personalised'
}

function duplicateResponse() {
  return NextResponse.json({ error: 'A category with this name already exists. Category names ignore spaces and letter case.' }, { status: 409 })
}

function isUniqueViolation(error: { code?: string | null; message?: string } | null): boolean {
  return error?.code === '23505' || /duplicate key|unique constraint/i.test(error?.message ?? '')
}

function activeReadinessResponse(name: string, readiness: ReturnType<typeof getInitialTemplateReadiness>, prefix: string) {
  return NextResponse.json({
    error: `${prefix} Complete the Initial Email template or save the category as Inactive.`,
    category: name,
    reasons: readiness.reasons,
    validationErrors: readiness.errors,
  }, { status: 422 })
}

export async function GET(): Promise<NextResponse> {
  const auth = await requireApiUser()
  if (isAuthErrorResponse(auth)) return auth
  const supabase = await createClient()
  const result = await fetchCategoriesAndTemplates(supabase)
  if (result.error) return NextResponse.json({ error: result.error.message }, { status: 500 })
  return NextResponse.json({ data: hydrateCategoryTemplates(result.categories, result.templates as never[]) })
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = await requireApiAdmin()
  if (isAuthErrorResponse(auth)) return auth
  const parsed = createSchema.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: 'Invalid category data', issues: parsed.error.issues }, { status: 400 })

  const supabase = await createClient()
  const { templates: templatePatches = {}, ...categoryInput } = parsed.data
  const name = categoryInput.name?.trim() ?? ''
  const { data: names, error: namesError } = await supabase.from('categories').select('id, name')
  if (namesError) return NextResponse.json({ error: namesError.message }, { status: 500 })
  if (isDuplicateCategoryName(names ?? [], name)) return duplicateResponse()

  const drafts = emptyTemplateDrafts()
  for (const type of EMAIL_TEMPLATE_TYPES) {
    const patch = templatePatches[type]
    if (patch) drafts[type] = mergeTemplateDraft(drafts[type], patch)
  }
  const readiness = getInitialTemplateReadiness(templatePatches.initial_pitch ? drafts.initial_pitch : null)
  const mode = await currentInitialMode(supabase)
  if (shouldBlockCategorySave({ status: categoryInput.status ?? 'active', initialEmailMode: mode === 'template' ? 'template' : 'ai_personalised', readiness })) {
    return activeReadinessResponse(name, readiness, 'Template mode is enabled, so an active category requires a valid Initial Email template.')
  }

  const { data: category, error: categoryError } = await supabase
    .from('categories')
    .insert({ ...categoryInput, name, status: categoryInput.status ?? 'active' })
    .select()
    .single()
  if (categoryError) return isUniqueViolation(categoryError) ? duplicateResponse() : NextResponse.json({ error: categoryError.message }, { status: 500 })

  const changedTypes = EMAIL_TEMPLATE_TYPES.filter((type) => templatePatches[type] !== undefined)
  if (changedTypes.length > 0) {
    const rows = changedTypes.map((type) => ({ category_id: category.id, ...drafts[type] }))
    const { error: templateError } = await supabase.from('category_email_templates').upsert(rows, { onConflict: 'category_id,template_type' })
    if (templateError) {
      const { error: rollbackError } = await supabase.from('categories').delete().eq('id', category.id)
      return NextResponse.json({
        error: rollbackError ? `Templates failed to save and category rollback failed: ${templateError.message}` : `Templates failed to save; the new category was rolled back: ${templateError.message}`,
      }, { status: 500 })
    }
  }

  const data = hydrateCategoryTemplates([category as CategoryRow], changedTypes.map((type) => ({ category_id: category.id, ...drafts[type] })))[0]
  return NextResponse.json({ data }, { status: 201 })
}

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  const auth = await requireApiAdmin()
  if (isAuthErrorResponse(auth)) return auth
  const parsed = updateSchema.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: 'Invalid category data', issues: parsed.error.issues }, { status: 400 })

  const supabase = await createClient()
  const { id, templates: templatePatches = {}, ...categoryUpdates } = parsed.data
  const [{ data: existing, error: existingError }, { data: existingRows, error: rowsError }, { data: names, error: namesError }] = await Promise.all([
    supabase.from('categories').select('*').eq('id', id).maybeSingle(),
    supabase.from('category_email_templates').select('*').eq('category_id', id),
    supabase.from('categories').select('id, name'),
  ])
  const loadError = existingError ?? rowsError ?? namesError
  if (loadError) return NextResponse.json({ error: loadError.message }, { status: 500 })
  if (!existing) return NextResponse.json({ error: 'Category not found' }, { status: 404 })

  const name = categoryUpdates.name?.trim() ?? existing.name
  if (isDuplicateCategoryName(names ?? [], name, id)) return duplicateResponse()
  const drafts = templatesForCategory((existingRows ?? []) as never[])
  for (const type of EMAIL_TEMPLATE_TYPES) {
    const patch = templatePatches[type]
    if (patch) drafts[type] = mergeTemplateDraft(drafts[type], patch)
  }

  const nextStatus = categoryUpdates.status ?? existing.status
  const mode = await currentInitialMode(supabase)
  const readiness = getInitialTemplateReadiness((existingRows ?? []).some((row) => row.template_type === 'initial_pitch') || templatePatches.initial_pitch ? drafts.initial_pitch : null)
  if (shouldBlockCategorySave({ status: nextStatus, initialEmailMode: mode === 'template' ? 'template' : 'ai_personalised', readiness })) {
    return activeReadinessResponse(name, readiness, 'Template mode is enabled, so an active category cannot have an invalid Initial Email template.')
  }

  const requestedCategoryUpdates = { ...categoryUpdates, ...(categoryUpdates.name !== undefined ? { name } : {}) }
  const categoryChanged = Object.entries(requestedCategoryUpdates).some(([key, value]) => JSON.stringify(existing[key]) !== JSON.stringify(value))
  let category = existing
  if (categoryChanged) {
    const { data, error: categoryError } = await supabase.from('categories')
      .update({ ...requestedCategoryUpdates, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single()
    if (categoryError) return isUniqueViolation(categoryError) ? duplicateResponse() : NextResponse.json({ error: categoryError.message }, { status: 500 })
    category = data
  }

  const changedTypes = EMAIL_TEMPLATE_TYPES.filter((type) => {
    const patch = templatePatches[type]
    if (!patch) return false
    const stored = (existingRows ?? []).find((row) => row.template_type === type)
    return (Object.prototype.hasOwnProperty.call(patch, 'subject_template') && (stored?.subject_template ?? null) !== (patch.subject_template ?? null))
      || (Object.prototype.hasOwnProperty.call(patch, 'body_template') && (stored?.body_template ?? null) !== (patch.body_template ?? null))
  })
  if (changedTypes.length > 0) {
    const rows = changedTypes.map((type) => ({ category_id: id, ...drafts[type] }))
    const { error: templateError } = await supabase.from('category_email_templates').upsert(rows, { onConflict: 'category_id,template_type' })
    if (templateError) {
      if (!categoryChanged) return NextResponse.json({ error: `Templates failed to save: ${templateError.message}` }, { status: 500 })
      const { id: _id, created_at: _createdAt, ...rollback } = existing
      const { error: rollbackError } = await supabase.from('categories').update(rollback).eq('id', id)
      return NextResponse.json({
        error: rollbackError
          ? `Templates failed to save and category rollback failed: ${templateError.message}`
          : `Templates failed to save; category changes were rolled back: ${templateError.message}`,
      }, { status: 500 })
    }
  }

  const allRows = EMAIL_TEMPLATE_TYPES.filter((type) => drafts[type].subject_template !== null || drafts[type].body_template !== null)
    .map((type) => ({ category_id: id, ...drafts[type] }))
  return NextResponse.json({ data: hydrateCategoryTemplates([category as CategoryRow], allRows)[0] })
}
