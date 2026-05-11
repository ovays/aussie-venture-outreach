import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { checkRateLimit } from '@/lib/rateLimit'
import { SETTINGS_DEFAULTS, isSettingKey } from '@/lib/settingsDefaults'

const patchSettingSchema = z.object({
  key: z.string().min(1).refine(isSettingKey, 'Unsupported setting key'),
  value: z.string(),
})

export async function GET(request: NextRequest): Promise<NextResponse> {
  const ip = request.headers.get('x-forwarded-for') ?? request.headers.get('x-real-ip') ?? 'global'
  const { allowed } = checkRateLimit(`settings:${ip}`, 30)
  if (!allowed) return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 })

  const supabase = await createClient()

  const { data, error } = await supabase.from('settings').select('*').order('key')

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  console.log('[SETTINGS_FETCH]', {
    keys: (data ?? []).map((setting) => setting.key),
    values: Object.fromEntries((data ?? []).map((setting) => [setting.key, setting.value])),
  })

  return NextResponse.json({ data })
}

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  const ip = request.headers.get('x-forwarded-for') ?? request.headers.get('x-real-ip') ?? 'global'
  const { allowed } = checkRateLimit(`settings:${ip}`, 30)
  if (!allowed) return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 })

  const supabase = await createClient()
  const raw = await request.json()

  const parsed = patchSettingSchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request body', issues: parsed.error.issues }, { status: 400 })
  }

  const { key, value } = parsed.data
  const defaults = SETTINGS_DEFAULTS[key]

  console.log('[SETTINGS_SAVE]', {
    keys: [key],
    values: { [key]: value },
  })

  const { data, error } = await supabase
    .from('settings')
    .upsert({
      key,
      value,
      description: defaults.description,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'key' })
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ data })
}
