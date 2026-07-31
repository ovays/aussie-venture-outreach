import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { testProviderConnection } from '@/ai/provider-connectivity'
import { isAuthErrorResponse, requireApiAdmin } from '@/lib/auth'
import { createServiceClient } from '@/lib/supabase/server'

const testSchema = z.object({ providerId: z.string().uuid() })

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message
  return 'Connection test failed'
}

export async function POST(request: NextRequest) {
  const auth = await requireApiAdmin()
  if (isAuthErrorResponse(auth)) return auth

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const parsed = testSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request body', issues: parsed.error.issues }, { status: 400 })
  }

  const supabase = createServiceClient()
  const { data: provider, error: providerError } = await supabase
    .from('ai_providers')
    .select('id, provider_key, ai_models(id, model_key, enabled)')
    .eq('id', parsed.data.providerId)
    .maybeSingle()

  if (providerError) return NextResponse.json({ error: providerError.message }, { status: 500 })
  if (!provider) return NextResponse.json({ error: 'Provider not found' }, { status: 404 })

  const models = (provider.ai_models ?? []) as Array<{ id: string; model_key: string; enabled: boolean }>
  const model = models.find((item) => item.enabled) ?? models[0]
  if (!model) {
    return NextResponse.json({ connected: false, error: 'Provider has no configured models' })
  }

  try {
    await testProviderConnection(provider.provider_key, model.model_key)
    return NextResponse.json({ connected: true })
  } catch (error) {
    return NextResponse.json({ connected: false, error: errorMessage(error) })
  }
}
