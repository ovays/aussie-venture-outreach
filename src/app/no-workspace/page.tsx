import { requireUser } from '@/lib/auth'
import { redirect } from 'next/navigation'
import { getWorkspaceContext } from '@/lib/workspace-context'
import { ProvisionWorkspace } from '@/components/onboarding/ProvisionWorkspace'

export default async function NoWorkspacePage() {
  const auth = await requireUser()
  if (auth.profile.role === 'admin') redirect('/dashboard')
  try { await getWorkspaceContext(auth); redirect('/onboarding') } catch (error) {
    if (!(error instanceof Error) || error.message !== 'No workspace membership') throw error
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-xl items-center px-6 py-16">
      <ProvisionWorkspace />
    </main>
  )
}
