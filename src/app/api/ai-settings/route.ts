import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { aiConfigurationService } from '@/ai/AIRuntime'
import { loadAISettings } from '@/ai/settings'
import { isAuthErrorResponse, requireApiAdmin, requireApiUser } from '@/lib/auth'
import { createServiceClient } from '@/lib/supabase/server'

const updateSchema = z.discriminatedUnion('resource', [
  z.object({
    resource: z.literal('provider'),
    id: z.string().uuid(),
    enabled: z.boolean(),
  }),
  z.object({
    resource: z.literal('model'),
    id: z.string().uuid(),
    enabled: z.boolean(),
  }),
  z.object({
    resource: z.literal('workflow'),
    id: z.string().uuid(),
    providerId: z.string().uuid(),
    modelId: z.string().uuid(),
  }),
])

export async function GET() {
  const auth = await requireApiUser()
  if (isAuthErrorResponse(auth)) return auth

  try {
    return NextResponse.json({ data: await loadAISettings() })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unable to load AI settings' },
      { status: 500 }
    )
  }
}

export async function PATCH(request: NextRequest) {
  const auth = await requireApiAdmin()
  if (isAuthErrorResponse(auth)) return auth

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const parsed = updateSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request body', issues: parsed.error.issues }, { status: 400 })
  }

  const supabase = createServiceClient()
  const update = parsed.data

  if (update.resource === 'provider') {
    if (!update.enabled) {
      const { data: assignment, error: assignmentError } = await supabase
        .from('ai_workflow_configurations')
        .select('id, ai_models!inner(provider_id)')
        .eq('enabled', true)
        .eq('ai_models.provider_id', update.id)
        .limit(1)
        .maybeSingle()

      if (assignmentError) {
        return NextResponse.json({ error: assignmentError.message }, { status: 500 })
      }
      if (assignment) {
        return NextResponse.json(
          { error: 'Reassign active workflows before disabling this provider' },
          { status: 409 }
        )
      }
    }

    const { data, error } = await supabase
      .from('ai_providers')
      .update({ enabled: update.enabled })
      .eq('id', update.id)
      .select('id')
      .maybeSingle()

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    if (!data) return NextResponse.json({ error: 'Provider not found' }, { status: 404 })
  }

  if (update.resource === 'model') {
    if (!update.enabled) {
      const { data: assignment, error: assignmentError } = await supabase
        .from('ai_workflow_configurations')
        .select('id')
        .eq('enabled', true)
        .eq('model_id', update.id)
        .limit(1)
        .maybeSingle()

      if (assignmentError) {
        return NextResponse.json({ error: assignmentError.message }, { status: 500 })
      }
      if (assignment) {
        return NextResponse.json(
          { error: 'Reassign active workflows before disabling this model' },
          { status: 409 }
        )
      }
    }

    const { data, error } = await supabase
      .from('ai_models')
      .update({ enabled: update.enabled })
      .eq('id', update.id)
      .select('id')
      .maybeSingle()

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    if (!data) return NextResponse.json({ error: 'Model not found' }, { status: 404 })
  }

  if (update.resource === 'workflow') {
    const { data: model, error: modelError } = await supabase
      .from('ai_models')
      .select('id, provider_id, enabled, ai_providers!inner(enabled)')
      .eq('id', update.modelId)
      .eq('provider_id', update.providerId)
      .eq('enabled', true)
      .eq('ai_providers.enabled', true)
      .maybeSingle()

    if (modelError) return NextResponse.json({ error: modelError.message }, { status: 500 })
    if (!model) {
      return NextResponse.json(
        { error: 'Select an enabled model belonging to the selected enabled provider' },
        { status: 400 }
      )
    }

    const { data, error } = await supabase
      .from('ai_workflow_configurations')
      .update({ model_id: update.modelId })
      .eq('id', update.id)
      .select('id')
      .maybeSingle()

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    if (!data) return NextResponse.json({ error: 'Workflow not found' }, { status: 404 })
  }

  aiConfigurationService.invalidate()
  return NextResponse.json({ data: await loadAISettings() })
}
