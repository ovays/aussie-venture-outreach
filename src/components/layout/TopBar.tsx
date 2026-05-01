'use client'

import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { LogOut } from 'lucide-react'

interface TopBarProps {
  title: string
}

export default function TopBar({ title }: TopBarProps) {
  const router = useRouter()

  async function handleSignOut() {
    const supabase = createClient()
    await supabase.auth.signOut()
    router.push('/login')
  }

  return (
    <header
      className="flex items-center justify-between px-6 py-4 border-b"
      style={{ borderColor: '#2a2d3e', background: '#1a1d27' }}
    >
      <h2 className="text-lg font-semibold text-white">{title}</h2>
      <button
        onClick={handleSignOut}
        className="flex items-center gap-2 text-sm px-3 py-1.5 rounded-lg transition-colors hover:text-white"
        style={{ color: '#94a3b8' }}
      >
        <LogOut size={14} />
        Sign out
      </button>
    </header>
  )
}
