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
  X,
} from 'lucide-react'
import { useSidebar } from './SidebarContext'

const navItems = [
  { href: '/dashboard',            label: 'Dashboard', icon: LayoutDashboard },
  { href: '/dashboard/leads',      label: 'Leads',     icon: Users           },
  { href: '/dashboard/dm-queue',   label: 'DM Queue',  icon: MessageSquare   },
  { href: '/dashboard/pipeline',   label: 'Pipeline',  icon: GitBranch       },
  { href: '/dashboard/email-log',  label: 'Email Log', icon: Mail            },
  { href: '/dashboard/deals',      label: 'Deals',     icon: DollarSign      },
  { href: '/dashboard/settings',   label: 'Settings',  icon: Settings        },
]

export default function Sidebar() {
  const pathname = usePathname()
  const { open, close } = useSidebar()

  // Close sidebar on route change (mobile nav)
  useEffect(() => { close() }, [pathname, close])

  return (
    <>
      {/* Mobile backdrop */}
      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/60 md:hidden"
          onClick={close}
        />
      )}

      <aside
        className={[
          'fixed inset-y-0 left-0 z-50 flex flex-col w-72 h-full',
          'transition-transform duration-300 ease-in-out',
          open ? 'translate-x-0' : '-translate-x-full',
          'md:relative md:inset-auto md:z-auto md:translate-x-0',
          'md:w-56 md:shrink-0 md:h-screen md:sticky md:top-0',
        ].join(' ')}
        style={{ background: '#1a1d27', borderRight: '1px solid #2a2d3e' }}
      >
        {/* Header */}
        <div className="px-5 py-5 border-b flex items-center justify-between" style={{ borderColor: '#2a2d3e' }}>
          <div>
            <h1 className="text-lg font-bold text-white leading-tight">Outreach OS</h1>
            <p className="text-xs mt-0.5" style={{ color: '#94a3b8' }}>Outreach System</p>
          </div>
          {/* Close button — mobile only */}
          <button
            onClick={close}
            className="md:hidden flex items-center justify-center w-10 h-10 rounded-lg transition-colors hover:bg-white/10 text-gray-400 hover:text-white"
            aria-label="Close menu"
          >
            <X size={18} />
          </button>
        </div>

        <nav className="flex-1 py-4 px-3 space-y-1 overflow-y-auto">
          {navItems.map(({ href, label, icon: Icon }) => {
            const active = pathname === href || (href !== '/dashboard' && pathname.startsWith(href))
            return (
              <Link
                key={href}
                href={href}
                onClick={close}
                className={`flex items-center gap-3 px-3 py-3 md:py-2.5 rounded-lg text-sm font-medium transition-colors ${
                  active ? 'text-white' : 'hover:text-white'
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
          v1.0.0
        </div>
      </aside>
    </>
  )
}
