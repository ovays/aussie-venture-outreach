import { NextRequest, NextResponse } from 'next/server'
import { isAuthErrorResponse, requireApiUser } from '@/lib/auth'
import { requireWorkspaceContext } from '@/lib/workspace-context'
import { createServiceClient } from '@/lib/supabase/server'
import {
  ONBOARDING_SETTING_KEYS,
  onboardingRequestSchema,
  preferencesStepSchema,
  profileStepSchema,
  workspaceStepSchema,
  type OnboardingStep,
} from '@/lib/onboarding'
import { getOnboardingState, upsertOnboardingSettings } from '@/lib/onboarding-server'
import { checkRateLimit } from '@/lib/rateLimit'

function validationResponse(issues: Array<{ path: PropertyKey[]; message: string }>) {
  const fieldErrors = Object.fromEntries(issues.map((issue) => [String(issue.path.at(-1) ?? 'form'), issue.message]))
  return NextResponse.json({ error: 'Check the highlighted fields', fieldErrors }, { status: 400 })
}

function canManageOnboarding(role: string, isPlatformAdmin: boolean): boolean {
  return isPlatformAdmin || role === 'owner' || role === 'admin'
}

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  const auth = await requireApiUser()
  if (isAuthErrorResponse(auth)) return auth
  const { allowed } = checkRateLimit(`onboarding:${auth.user.id}`, 60)
  if (!allowed) return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 })

  const workspace = await requireWorkspaceContext(auth)
  if (!canManageOnboarding(workspace.role, workspace.isPlatformAdmin)) {
    return NextResponse.json({ error: 'Workspace admin access is required' }, { status: 403 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const parsed = onboardingRequestSchema.safeParse(body)
  if (!parsed.success) return validationResponse(parsed.error.issues)

  const input = parsed.data
  const current = await getOnboardingState(workspace.workspaceId)
  if (current.status === 'completed') {
    return NextResponse.json({ data: current })
  }

  if (input.action === 'navigate') {
    const requested = input.step as OnboardingStep
    if (requested > current.currentStep) {
      return NextResponse.json({ error: 'Complete the current step before continuing' }, { status: 409 })
    }
    await upsertOnboardingSettings(workspace.workspaceId, {
      [ONBOARDING_SETTING_KEYS.status]: 'in_progress',
      [ONBOARDING_SETTING_KEYS.currentStep]: String(requested),
    })
  }

  if (input.action === 'advance' && input.step === 1) {
    await upsertOnboardingSettings(workspace.workspaceId, {
      [ONBOARDING_SETTING_KEYS.status]: 'in_progress',
      [ONBOARDING_SETTING_KEYS.currentStep]: '2',
    })
  }

  if (input.action === 'advance' && input.step === 2) {
    const { workspaceName, website, industry, country, timezone } = input.data
    const { error } = await createServiceClient()
      .from('workspaces')
      .update({ name: workspaceName })
      .eq('id', workspace.workspaceId)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    await upsertOnboardingSettings(workspace.workspaceId, {
      [ONBOARDING_SETTING_KEYS.website]: website,
      [ONBOARDING_SETTING_KEYS.industry]: industry,
      [ONBOARDING_SETTING_KEYS.country]: country,
      [ONBOARDING_SETTING_KEYS.timezone]: timezone,
      [ONBOARDING_SETTING_KEYS.status]: 'in_progress',
      [ONBOARDING_SETTING_KEYS.currentStep]: '3',
    })
  }

  if (input.action === 'advance' && input.step === 3) {
    const { senderName, brandName, companyDescription, primaryGoal } = input.data
    await upsertOnboardingSettings(workspace.workspaceId, {
      [ONBOARDING_SETTING_KEYS.senderName]: senderName,
      [ONBOARDING_SETTING_KEYS.brandName]: brandName,
      [ONBOARDING_SETTING_KEYS.companyDescription]: companyDescription,
      [ONBOARDING_SETTING_KEYS.primaryGoal]: primaryGoal,
      [ONBOARDING_SETTING_KEYS.status]: 'in_progress',
      [ONBOARDING_SETTING_KEYS.currentStep]: '4',
    })
  }

  if (input.action === 'advance' && input.step === 4) {
    await upsertOnboardingSettings(workspace.workspaceId, {
      [ONBOARDING_SETTING_KEYS.primaryMarket]: input.data.primaryMarket,
      [ONBOARDING_SETTING_KEYS.status]: 'in_progress',
      [ONBOARDING_SETTING_KEYS.currentStep]: '5',
    })
  }

  if (input.action === 'complete') {
    const state = await getOnboardingState(workspace.workspaceId)
    const validations = [
      workspaceStepSchema.safeParse(state),
      profileStepSchema.safeParse(state),
      preferencesStepSchema.safeParse(state),
    ]
    const failed = validations.find((result) => !result.success)
    if (failed && !failed.success) return validationResponse(failed.error.issues)

    await upsertOnboardingSettings(workspace.workspaceId, {
      [ONBOARDING_SETTING_KEYS.status]: 'completed',
      [ONBOARDING_SETTING_KEYS.currentStep]: '5',
      [ONBOARDING_SETTING_KEYS.completedAt]: new Date().toISOString(),
    })
  }

  return NextResponse.json({ data: await getOnboardingState(workspace.workspaceId) })
}
