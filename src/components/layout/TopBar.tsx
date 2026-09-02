'use client'

import { Menu } from 'lucide-react'
import { useSidebar } from './SidebarContext'

interface TopBarProps {
  title: string
  subtitle?: string
  actions?: React.ReactNode
}

const defaultSubtitles: Record<string, string> = {
  Leads: 'Manage discovered and contacted businesses',
  Pipeline: 'Track opportunities through every stage',
  'DM Queue': 'Review and action social outreach',
  'Email Log': 'Review sent outreach and delivery activity',
  'Email Report': 'Monitor outreach performance and engagement',
  'Delivery Failures': 'Resolve failed and suppressed deliveries',
  Lifecycle: 'Manage follow-ups and reactivation activity',
  Deals: 'Track active commercial opportunities',
}

export default function TopBar({ title, subtitle, actions }: TopBarProps) {
  const { toggle } = useSidebar()
  const context = subtitle ?? defaultSubtitles[title]

  return (
    <header
      className="sticky top-0 z-30 flex min-h-16 items-center justify-between gap-3 border-b px-[var(--page-gutter)] py-2.5 backdrop-blur-xl"
      style={{ background: 'rgb(10 11 13 / 88%)', borderColor: 'var(--border-subtle)' }}
    >
      <div className="flex items-center gap-3 min-w-0">
        <button
          onClick={toggle}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] md:hidden"
          aria-label="Open menu"
          aria-controls="app-sidebar"
        >
          <Menu size={18} />
        </button>
        <div className="min-w-0">
          <h1 className="truncate text-base font-semibold tracking-[-0.01em] text-[var(--text-primary)] md:text-lg">{title}</h1>
          {context && <p className="hidden truncate text-xs text-[var(--text-muted)] sm:block">{context}</p>}
        </div>
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  )
}
