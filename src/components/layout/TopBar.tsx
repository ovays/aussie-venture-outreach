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
      className="flex items-center justify-between px-4 md:px-6 py-3 md:py-4 border-b"
      style={{ borderColor: '#2a2d3e', background: '#1a1d27' }}
    >
      <div className="flex items-center gap-2">
        {/* Hamburger — mobile only */}
        <button
          onClick={toggle}
          className="md:hidden flex items-center justify-center w-10 h-10 rounded-lg transition-colors hover:bg-white/10 text-gray-400 hover:text-white shrink-0"
          aria-label="Open menu"
        >
          <Menu size={20} />
        </button>
        <h2 className="text-base md:text-lg font-semibold text-white">{title}</h2>
      </div>

      <button
        onClick={handleSignOut}
        className="flex items-center gap-2 text-sm px-3 py-2 rounded-lg transition-colors hover:text-white min-h-[44px]"
        style={{ color: '#94a3b8' }}
      >
        <LogOut size={14} />
        <span className="hidden sm:inline">Sign out</span>
      </button>
    </header>
  )
}
