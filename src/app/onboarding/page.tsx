import { redirect } from 'next/navigation'
import { requireUser } from '@/lib/auth'
import { requireWorkspaceContext } from '@/lib/workspace-context'
import { getOnboardingState } from '@/lib/onboarding-server'
import { onboardingDestination, timezoneOptions } from '@/lib/onboarding'
import { OnboardingFlow } from '@/components/onboarding/OnboardingFlow'

export const dynamic = 'force-dynamic'

export default async function OnboardingPage() {
  const auth = await requireUser()
  const workspace = await requireWorkspaceContext(auth)
  const state = await getOnboardingState(workspace.workspaceId)
  const destination = onboardingDestination('onboarding', state.status)
  if (destination) redirect(destination)

  return (
    <OnboardingFlow
      initialState={state}
      timezones={timezoneOptions()}
      userEmail={auth.user.email ?? auth.profile.email}
      userName={auth.profile.full_name}
      canManage={workspace.isPlatformAdmin || workspace.role === 'owner' || workspace.role === 'admin'}
    />
  )
}
