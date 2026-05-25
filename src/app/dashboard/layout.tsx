import { requireUser } from '@/lib/auth'
import Sidebar from '@/components/layout/Sidebar'
import { HealthBanner } from '@/components/layout/HealthBanner'
import { SidebarProvider } from '@/components/layout/SidebarContext'
import { LeadDrawerProvider } from '@/lib/lead-drawer-context'
import { LeadCRMDrawer } from '@/components/leads/LeadCRMDrawer'

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { profile } = await requireUser()

  return (
    <SidebarProvider>
      <LeadDrawerProvider>
        <div className="flex h-screen overflow-hidden" style={{ background: '#0c0e16' }}>
          <Sidebar role={profile.role} />
          <main className="flex-1 overflow-y-auto min-w-0">
            <HealthBanner />
            {children}
          </main>
        </div>
        <LeadCRMDrawer />
      </LeadDrawerProvider>
    </SidebarProvider>
  )
}
