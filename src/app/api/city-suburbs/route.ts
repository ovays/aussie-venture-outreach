import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { isAuthErrorResponse, requireApiAdmin, requireApiUser } from '@/lib/auth'
import { clampSuburbPriority, groupEffectiveSuburbPriorities } from '@/lib/suburb-priorities'

const uuidSchema = z.string().uuid()
const createSchema = z.object({
  city: z.string().trim().min(1),
  suburb: z.string().trim().min(1),
}).strict()
const patchSchema = z.object({
  id: z.string().uuid(),
  categoryId: z.string().uuid().optional(),
  active: z.boolean().optional(),
  priority: z.number().finite().optional(),
}).strict()
const deleteSchema = z.union([
  z.object({ categoryId: z.string().uuid() }).strict(),
  z.object({ id: z.string().uuid() }).strict(),
])

export async function GET(req: NextRequest) {
  const auth = await requireApiUser()
  if (isAuthErrorResponse(auth)) return auth

  const categoryId = req.nextUrl.searchParams.get('categoryId')
  if (categoryId && !uuidSchema.safeParse(categoryId).success) {
    return NextResponse.json({ error: 'Invalid category ID' }, { status: 400 })
  }

  const supabase = await createClient()
  const suburbsQuery = supabase
    .from('city_suburbs')
    .select('id, city, suburb, active, priority')
    .order('city')
    .order('suburb')

  if (!categoryId) {
    const { data, error } = await suburbsQuery
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({
      data: groupEffectiveSuburbPriorities(data ?? []),
      prioritySet: { scope: 'global', customized: false },
    })
  }

  const [{ data: suburbs, error: suburbError }, { data: priorities, error: priorityError }, { data: category, error: categoryError }] = await Promise.all([
    suburbsQuery,
    supabase
      .from('category_suburb_priorities')
      .select('city_suburb_id, priority')
      .eq('category_id', categoryId),
    supabase.from('categories').select('id').eq('id', categoryId).maybeSingle(),
  ])
  const error = suburbError ?? priorityError ?? categoryError
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!category) return NextResponse.json({ error: 'Category not found' }, { status: 404 })

  const categoryPriorities = priorities ?? []
  return NextResponse.json({
    data: groupEffectiveSuburbPriorities(suburbs ?? [], categoryPriorities),
    prioritySet: {
      scope: 'category',
      categoryId,
      customized: categoryPriorities.length > 0,
      mappingCount: categoryPriorities.length,
    },
  })
}

export async function POST(req: NextRequest) {
  const auth = await requireApiAdmin()
  if (isAuthErrorResponse(auth)) return auth
  const parsed = createSchema.safeParse(await req.json())
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid suburb data', issues: parsed.error.issues }, { status: 400 })
  }

  const supabase = await createClient()
  const { city, suburb } = parsed.data

  const { data, error } = await supabase
    .from('city_suburbs')
    .insert({ city, suburb, active: true })
    .select('id, city, suburb, active, priority')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ data })
}

export async function PATCH(req: NextRequest) {
  const auth = await requireApiAdmin()
  if (isAuthErrorResponse(auth)) return auth
  const parsed = patchSchema.safeParse(await req.json())
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid suburb update', issues: parsed.error.issues }, { status: 400 })
  }

  const supabase = await createClient()
  const body = parsed.data

  if (body.categoryId) {
    if (body.priority === undefined || body.active !== undefined) {
      return NextResponse.json({ error: 'Category priority updates require only a priority' }, { status: 400 })
    }
    const priority = clampSuburbPriority(body.priority)
    const { error } = await supabase
      .from('category_suburb_priorities')
      .upsert({
        category_id: body.categoryId,
        city_suburb_id: body.id,
        priority,
      }, { onConflict: 'category_id,city_suburb_id' })

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true, priority, customized: true })
  }

  const updates: Record<string, unknown> = {}
  if (body.active !== undefined) updates.active = body.active
  if (body.priority !== undefined) updates.priority = clampSuburbPriority(body.priority)
  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'No suburb updates supplied' }, { status: 400 })
  }

  const { error } = await supabase
    .from('city_suburbs')
    .update(updates)
    .eq('id', body.id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

export async function DELETE(req: NextRequest) {
  const auth = await requireApiAdmin()
  if (isAuthErrorResponse(auth)) return auth
  const parsed = deleteSchema.safeParse(await req.json())
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid delete request', issues: parsed.error.issues }, { status: 400 })
  }

  const supabase = await createClient()
  if ('categoryId' in parsed.data) {
    const { error } = await supabase
      .from('category_suburb_priorities')
      .delete()
      .eq('category_id', parsed.data.categoryId)

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true, customized: false })
  }

  const { id } = parsed.data

  const { error } = await supabase
    .from('city_suburbs')
    .delete()
    .eq('id', id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
