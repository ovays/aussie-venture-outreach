import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { isAuthErrorResponse, requireApiUser } from '@/lib/auth'
import { requireWorkspaceContext } from '@/lib/workspace-context'
import { createServiceClient } from '@/lib/supabase/server'
import { ONBOARDING_SETTING_KEYS, profileStepSchema, workspaceStepSchema } from '@/lib/onboarding'
import { getOnboardingState, upsertOnboardingSettings } from '@/lib/onboarding-server'
import { checkRateLimit } from '@/lib/rateLimit'

const workspaceProfileSchema = z.object({
  workspace: workspaceStepSchema,
  profile: profileStepSchema,
})

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  const auth = await requireApiUser()
  if (isAuthErrorResponse(auth)) return auth
  const { allowed } = checkRateLimit(`workspace-profile:${auth.user.id}`, 30)
  if (!allowed) return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 })
  const workspace = await requireWorkspaceContext(auth)
  if (!(workspace.isPlatformAdmin || workspace.role === 'owner' || workspace.role === 'admin')) {
    return NextResponse.json({ error: 'Workspace admin access is required' }, { status: 403 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const parsed = workspaceProfileSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({
      error: 'Check the highlighted fields',
      fieldErrors: Object.fromEntries(parsed.error.issues.map((issue) => [String(issue.path.at(-1)), issue.message])),
    }, { status: 400 })
  }

  const { workspace: workspaceData, profile } = parsed.data
  const { error } = await createServiceClient().from('workspaces')
    .update({ name: workspaceData.workspaceName })
    .eq('id', workspace.workspaceId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await upsertOnboardingSettings(workspace.workspaceId, {
    [ONBOARDING_SETTING_KEYS.website]: workspaceData.website,
    [ONBOARDING_SETTING_KEYS.industry]: workspaceData.industry,
    [ONBOARDING_SETTING_KEYS.country]: workspaceData.country,
    [ONBOARDING_SETTING_KEYS.timezone]: workspaceData.timezone,
    [ONBOARDING_SETTING_KEYS.senderName]: profile.senderName,
    [ONBOARDING_SETTING_KEYS.brandName]: profile.brandName,
    [ONBOARDING_SETTING_KEYS.companyDescription]: profile.companyDescription,
    [ONBOARDING_SETTING_KEYS.primaryGoal]: profile.primaryGoal,
  })

  return NextResponse.json({ data: await getOnboardingState(workspace.workspaceId) })
}
