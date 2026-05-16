'use client'

import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { LogOut, Menu } from 'lucide-react'
import { useSidebar } from './SidebarContext'

interface TopBarProps {
  title: string
}

export default function TopBar({ title }: TopBarProps) {
  const router = useRouter()
  const { toggle } = useSidebar()

  async function handleSignOut() {
    const supabase = createClient()
    await supabase.auth.signOut()
    router.push('/login')
  }

  return (
    <header
      className="sticky top-0 z-30 flex items-center justify-between px-4 md:px-6 py-3 md:py-3.5"
      style={{ background: '#13151f', borderBottom: '1px solid #2a2d3e' }}
    >
      <div className="flex items-center gap-3 min-w-0">
        <button
          onClick={toggle}
          className="md:hidden flex items-center justify-center w-9 h-9 rounded-lg text-slate-400 hover:text-white hover:bg-white/8 shrink-0"
          aria-label="Open menu"
        >
          <Menu size={18} />
        </button>
        <h2 className="text-base font-semibold text-white truncate">{title}</h2>
      </div>

      <button
        onClick={handleSignOut}
        className="flex items-center gap-2 text-sm px-3 py-2 rounded-lg text-slate-400 hover:text-white hover:bg-white/5 shrink-0"
        aria-label="Sign out"
      >
        <LogOut size={14} />
        <span className="hidden sm:inline">Sign out</span>
      </button>
    </header>
  )
}
