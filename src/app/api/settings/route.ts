import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createWorkspaceServiceClient } from '@/lib/supabase/workspace-service'
import { checkRateLimit } from '@/lib/rateLimit'
import { SETTINGS_DEFAULTS, isInitialEmailMode, isSettingKey } from '@/lib/settingsDefaults'
import { isAuthErrorResponse, requireApiAdmin, requireApiUser } from '@/lib/auth'
import { requireWorkspaceContext } from '@/lib/workspace-context'
import { isPlatformSettingKey, getPlatformSettings, getWorkspaceSettings, upsertPlatformSetting, upsertWorkspaceSetting } from '@/lib/workspace-settings'
import { getTemplateModeBlockers } from '@/lib/category-email-templates'
import type { CategoryEmailTemplateDraft } from '@/lib/email-template-types'

const patchSettingSchema = z.object({
  key: z.string().min(1).refine(isSettingKey, 'Unsupported setting key'),
  value: z.string(),
}).superRefine(({ key, value }, ctx) => {
  if (key === 'initial_email_mode' && !isInitialEmailMode(value)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['value'],
      message: 'Initial email mode must be ai_personalised or template',
    })
  }
})

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = await requireApiUser()
  if (isAuthErrorResponse(auth)) return auth
  const ip = request.headers.get('x-forwarded-for') ?? request.headers.get('x-real-ip') ?? 'global'
  const { allowed } = checkRateLimit(`settings:${ip}`, 30)
  if (!allowed) return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 })

  const workspace = await requireWorkspaceContext(auth)
  const supabase = createWorkspaceServiceClient(workspace.workspaceId)

  const settingKeys = Object.keys(SETTINGS_DEFAULTS) as Array<keyof typeof SETTINGS_DEFAULTS>
  const [platform, tenant] = await Promise.all([
    getPlatformSettings(settingKeys),
    getWorkspaceSettings(workspace.workspaceId, settingKeys),
  ])

  const rows = Object.entries(SETTINGS_DEFAULTS).map(([key, defaults]) => ({
    key,
    value: platform.get(key) ?? tenant.get(key) ?? defaults.value,
    description: defaults.description,
  })).sort((a, b) => a.key.localeCompare(b.key))

  return NextResponse.json({ data: rows })
}

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  const auth = await requireApiAdmin()
  if (isAuthErrorResponse(auth)) return auth
  const ip = request.headers.get('x-forwarded-for') ?? request.headers.get('x-real-ip') ?? 'global'
  const { allowed } = checkRateLimit(`settings:${ip}`, 30)
  if (!allowed) return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 })

  const workspace = await requireWorkspaceContext(auth)
  const supabase = createWorkspaceServiceClient(workspace.workspaceId)
  const raw = await request.json()

  const parsed = patchSettingSchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request body', issues: parsed.error.issues }, { status: 400 })
  }

  const { key, value } = parsed.data
  const defaults = SETTINGS_DEFAULTS[key]

  if (key === 'initial_email_mode' && value === 'template') {
    const [{ data: categories, error: categoryError }, { data: templates, error: templateError }] = await Promise.all([
      supabase.from('categories').select('id, name, status').eq('workspace_id', workspace.workspaceId).eq('status', 'active').order('name'),
      supabase.from('category_email_templates').select('category_id, template_type, subject_template, body_template').eq('workspace_id', workspace.workspaceId).eq('template_type', 'initial_pitch'),
    ])
    const loadError = categoryError ?? templateError
    if (loadError) return NextResponse.json({ error: loadError.message }, { status: 500 })

    const blockers = getTemplateModeBlockers((categories ?? []).map((category) => {
      const row = (templates ?? []).find((template) => template.category_id === category.id)
      const initialTemplate: CategoryEmailTemplateDraft | null = row ? {
        template_type: 'initial_pitch',
        subject_template: row.subject_template,
        body_template: row.body_template,
      } : null
      return { name: category.name, status: category.status as 'active', initialTemplate }
    }))
    if (blockers.length > 0) {
      return NextResponse.json({
        error: 'Template mode cannot be enabled until every active category has a valid Initial Email template.',
        blockers,
      }, { status: 422 })
    }
  }

  if (isPlatformSettingKey(key)) {
    await upsertPlatformSetting(key, value, defaults.description)
  } else {
    await upsertWorkspaceSetting(workspace.workspaceId, key, value, defaults.description)
  }

  return NextResponse.json({ data: { key, value } })
}
