'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  LayoutDashboard,
  Users,
  MessageSquare,
  GitBranch,
  Mail,
  DollarSign,
  Settings,
} from 'lucide-react'

const navItems = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/dashboard/leads', label: 'Leads', icon: Users },
  { href: '/dashboard/dm-queue', label: 'DM Queue', icon: MessageSquare },
  { href: '/dashboard/pipeline', label: 'Pipeline', icon: GitBranch },
  { href: '/dashboard/email-log', label: 'Email Log', icon: Mail },
  { href: '/dashboard/deals', label: 'Deals', icon: DollarSign },
  { href: '/dashboard/settings', label: 'Settings', icon: Settings },
]

export default function Sidebar() {
  const pathname = usePathname()

  return (
    <aside
      className="flex flex-col w-56 shrink-0 h-screen sticky top-0"
      style={{ background: '#1a1d27', borderRight: '1px solid #2a2d3e' }}
    >
      <div className="px-5 py-6 border-b" style={{ borderColor: '#2a2d3e' }}>
        <h1 className="text-lg font-bold text-white leading-tight">Aussie Venture</h1>
        <p className="text-xs mt-0.5" style={{ color: '#94a3b8' }}>Outreach System</p>
      </div>

      <nav className="flex-1 py-4 px-3 space-y-1">
        {navItems.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || (href !== '/dashboard' && pathname.startsWith(href))
          return (
            <Link
              key={href}
              href={href}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                active
                  ? 'text-white'
                  : 'hover:text-white'
              }`}
              style={{
                background: active ? '#0284c7' : 'transparent',
                color: active ? 'white' : '#94a3b8',
              }}
            >
              <Icon size={16} />
              {label}
            </Link>
          )
        })}
      </nav>

      <div className="px-5 py-4 border-t text-xs" style={{ borderColor: '#2a2d3e', color: '#64748b' }}>
        hello@aussieventure.com
      </div>
    </aside>
  )
}
