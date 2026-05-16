'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect } from 'react'
import {
  LayoutDashboard,
  Users,
  MessageSquare,
  GitBranch,
  Mail,
  DollarSign,
  Settings,
  Shield,
  X,
} from 'lucide-react'
import { useSidebar } from './SidebarContext'
import type { UserRole } from '@/lib/auth-types'

const navItems = [
  { href: '/dashboard',           label: 'Dashboard', icon: LayoutDashboard, adminOnly: false },
  { href: '/dashboard/leads',     label: 'Leads',     icon: Users,           adminOnly: false },
  { href: '/dashboard/dm-queue',  label: 'DM Queue',  icon: MessageSquare,   adminOnly: false },
  { href: '/dashboard/pipeline',  label: 'Pipeline',  icon: GitBranch,       adminOnly: false },
  { href: '/dashboard/email-log', label: 'Email Log', icon: Mail,            adminOnly: false },
  { href: '/dashboard/deals',     label: 'Deals',     icon: DollarSign,      adminOnly: false },
  { href: '/dashboard/settings',  label: 'Settings',  icon: Settings,        adminOnly: false },
  { href: '/dashboard/admin',     label: 'Admin',     icon: Shield,          adminOnly: true  },
]

export default function Sidebar({ role }: { role: UserRole }) {
  const pathname = usePathname()
  const { open, close } = useSidebar()
  const visibleNavItems = navItems.filter((item) => !item.adminOnly || role === 'admin')

  useEffect(() => { close() }, [pathname, close])

  return (
    <>
      {/* Mobile backdrop */}
      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm md:hidden"
          onClick={close}
        />
      )}

      <aside
        className={[
          'fixed inset-y-0 left-0 z-50 flex flex-col w-64 h-full',
          'transition-transform duration-300 ease-in-out',
          open ? 'translate-x-0' : '-translate-x-full',
          'md:relative md:inset-auto md:z-auto md:translate-x-0',
          'md:w-52 md:shrink-0 md:h-screen md:sticky md:top-0',
        ].join(' ')}
        style={{ background: '#13151f', borderRight: '1px solid #2a2d3e' }}
      >
        {/* Logo */}
        <div className="px-4 py-4 flex items-center justify-between" style={{ borderBottom: '1px solid #2a2d3e' }}>
          <div className="flex items-center gap-2.5">
            <div
              className="flex h-7 w-7 items-center justify-center rounded-lg text-xs font-bold text-white shrink-0"
              style={{ background: '#0284c7' }}
            >
              R
            </div>
            <div>
              <p className="text-sm font-bold text-white leading-none">ReachAgent</p>
              <p className="text-xs mt-0.5" style={{ color: '#475569' }}>Outreach Automation</p>
            </div>
          </div>
          <button
            onClick={close}
            className="md:hidden flex items-center justify-center w-8 h-8 rounded-lg hover:bg-white/10 text-gray-500 hover:text-white"
            aria-label="Close menu"
          >
            <X size={16} />
          </button>
        </div>

        {/* Nav */}
        <nav className="flex-1 py-3 px-2 space-y-0.5 overflow-y-auto">
          {visibleNavItems.map(({ href, label, icon: Icon }) => {
            const active = pathname === href || (href !== '/dashboard' && pathname.startsWith(href))
            return (
              <Link
                key={href}
                href={href}
                className={[
                  'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium relative',
                  active
                    ? 'text-white'
                    : 'text-slate-400 hover:text-white hover:bg-white/5',
                ].join(' ')}
                style={active ? { background: 'rgba(2,132,199,0.15)', color: '#38bdf8' } : {}}
              >
                {active && (
                  <span
                    className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-r-full"
                    style={{ background: '#0284c7' }}
                  />
                )}
                <Icon size={15} className="shrink-0" />
                {label}
              </Link>
            )
          })}
        </nav>

        <div className="px-4 py-3" style={{ borderTop: '1px solid #1e2130', color: '#3a3d4e' }}>
          <p className="text-xs">v1.0.0</p>
        </div>
      </aside>
    </>
  )
}
