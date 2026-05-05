import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import Sidebar from '@/components/layout/Sidebar'
import { HealthBanner } from '@/components/layout/HealthBanner'
import { SidebarProvider } from '@/components/layout/SidebarContext'

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  return (
    <SidebarProvider>
      <div className="flex h-screen overflow-hidden" style={{ background: '#0f1117' }}>
        <Sidebar />
        <main className="flex-1 overflow-y-auto min-w-0">
          <HealthBanner />
          {children}
        </main>
      </div>
    </SidebarProvider>
  )
}
