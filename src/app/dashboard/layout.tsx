import Sidebar from '@/components/layout/Sidebar'
import { HealthBanner } from '@/components/layout/HealthBanner'
import { SidebarProvider } from '@/components/layout/SidebarContext'
import { LeadDrawerProvider } from '@/lib/lead-drawer-context'
import { LeadCRMDrawer } from '@/components/leads/LeadCRMDrawer'
import { createServiceClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { getOnboardingState } from '@/lib/onboarding-server'
import { onboardingDestination } from '@/lib/onboarding'
import { requireWorkspacePage } from '@/lib/page-access'

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { auth, workspace } = await requireWorkspacePage()
  const onboarding = await getOnboardingState(workspace.workspaceId)
  const destination = onboardingDestination('dashboard', onboarding.status)
  if (destination) redirect(destination)
  const { data: workspaceRecord } = await createServiceClient()
    .from('workspaces')
    .select('name')
    .eq('id', workspace.workspaceId)
    .maybeSingle()

  return (
    <SidebarProvider>
      <LeadDrawerProvider>
        <div className="app-shell flex h-dvh overflow-hidden">
          <Sidebar
            role={auth.profile.role}
            userName={auth.profile.full_name}
            userEmail={auth.user.email}
            workspaceName={workspaceRecord?.name ?? 'Active workspace'}
          />
          <main className="min-w-0 flex-1 overflow-y-auto" id="main-content">
            {workspace.isPlatformAdmin && <HealthBanner />}
            {children}
          </main>
        </div>
        <LeadCRMDrawer />
      </LeadDrawerProvider>
    </SidebarProvider>
  )
}
