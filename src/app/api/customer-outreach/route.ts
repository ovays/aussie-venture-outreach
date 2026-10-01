import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { isApiWorkspaceError, requireApiWorkspaceAdmin, requireApiWorkspaceUser } from '@/lib/api-workspace'
import { ONBOARDING_SETTING_KEYS as K } from '@/lib/onboarding'
import { upsertOnboardingSettings } from '@/lib/onboarding-server'
import { getCustomerOutreach } from '@/lib/customer-outreach'

const preferencesSchema = z.object({
  action: z.literal('preferences'),
  mode: z.enum(['template', 'ai_personalised']),
  automaticFollowups: z.boolean(),
  first: z.number().int().min(1).max(365),
  second: z.number().int().min(1).max(365),
  final: z.number().int().min(1).max(365),
  reconnect: z.number().int().min(1).max(730),
}).strict()
const categoryCreateSchema = z.object({ action: z.literal('create_category'), name: z.string().trim().min(1).max(80) }).strict()
const categoryUpdateSchema = z.object({ action: z.literal('update_category'), id: z.string().uuid(), name: z.string().trim().min(1).max(80).optional(), enabled: z.boolean().optional() }).strict()
const locationCreateSchema = z.object({ action: z.literal('create_location'), city: z.string().trim().min(1).max(120), suburb: z.string().trim().max(120) }).strict()
const locationDeleteSchema = z.object({ action: z.literal('delete_location'), id: z.string().uuid() }).strict()
const requestSchema = z.discriminatedUnion('action', [preferencesSchema, categoryCreateSchema, categoryUpdateSchema, locationCreateSchema, locationDeleteSchema])

export async function GET(): Promise<NextResponse> {
  const context = await requireApiWorkspaceUser()
  if (isApiWorkspaceError(context)) return context
  const canEdit = context.workspace.isPlatformAdmin || context.workspace.role === 'owner' || context.workspace.role === 'admin'
  try { return NextResponse.json({ data: await getCustomerOutreach(context.workspace.workspaceId, canEdit) }) }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'Unable to load outreach settings' }, { status: 500 }) }
}

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  const context = await requireApiWorkspaceAdmin()
  if (isApiWorkspaceError(context)) return context
  let body: unknown
  try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }
  const parsed = requestSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'Check the supplied outreach settings', issues: parsed.error.issues }, { status: 400 })
  const input = parsed.data
  try {
    if (input.action === 'preferences') {
      if (!(input.first < input.second && input.second < input.final && input.final < input.reconnect)) return NextResponse.json({ error: 'Follow-up days must increase in order' }, { status: 400 })
      await upsertOnboardingSettings(context.workspace.workspaceId, {
        [K.mode]: input.mode, [K.automaticFollowups]: String(input.automaticFollowups), [K.first]: String(input.first),
        [K.second]: String(input.second), [K.final]: String(input.final), [K.reconnect]: String(input.reconnect),
      })
    } else if (input.action === 'create_category') {
      const { data: existing } = await context.supabase.from('categories').select('id').ilike('name', input.name).maybeSingle()
      if (existing) return NextResponse.json({ error: 'A category with this name already exists' }, { status: 409 })
      const { error } = await context.supabase.from('categories').insert({ workspace_id: context.workspace.workspaceId, name: input.name, status: 'paused' })
      if (error) throw error
    } else if (input.action === 'update_category') {
      const updates: { name?: string; status?: string; workspace_id: string } = { workspace_id: context.workspace.workspaceId }
      if (input.name !== undefined) updates.name = input.name
      if (input.enabled !== undefined) updates.status = input.enabled ? 'active' : 'paused'
      if (!Object.keys(updates).length) return NextResponse.json({ error: 'No category changes supplied' }, { status: 400 })
      const { data, error } = await context.supabase.from('categories').update(updates).eq('id', input.id).select('id').maybeSingle()
      if (error) throw error
      if (!data) return NextResponse.json({ error: 'Category not found' }, { status: 404 })
    } else if (input.action === 'create_location') {
      const { error } = await context.supabase.from('city_suburbs').insert({ workspace_id: context.workspace.workspaceId, city: input.city, suburb: input.suburb, active: true })
      if (error) throw error
      if (!input.suburb) await upsertOnboardingSettings(context.workspace.workspaceId, { [K.primaryCity]: input.city, [K.activeCities]: input.city })
    } else {
      const { data, error } = await context.supabase.from('city_suburbs').delete().eq('id', input.id).select('id').maybeSingle()
      if (error) throw error
      if (!data) return NextResponse.json({ error: 'Location not found' }, { status: 404 })
    }
    return NextResponse.json({ data: await getCustomerOutreach(context.workspace.workspaceId, true) })
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'Unable to save outreach settings' }, { status: 500 }) }
}
