'use client'

import { Menu } from 'lucide-react'
import { usePathname } from 'next/navigation'
import { Breadcrumbs, type BreadcrumbItem } from '@/components/ui/Breadcrumbs'
import { useSidebar } from './SidebarContext'

interface TopBarProps { title: string; subtitle?: string; actions?: React.ReactNode; breadcrumbs?: BreadcrumbItem[] }

const defaultSubtitles: Record<string, string> = {
  Dashboard: 'A clear view of outreach, lead progress, and work needing attention',
  Leads: 'Search, filter, and manage every business in your workspace',
  Pipeline: 'Move opportunities through your outreach workflow',
  'DM Queue': 'Review social outreach that is ready for action',
  'Email Log': 'ReachAgent application send history',
  'Email Report': 'Live mailbox and provider reporting',
  'Delivery Failures': 'Review failed and suppressed delivery attempts',
  Lifecycle: 'Manage follow-ups and reactivation activity',
  Deals: 'Track active commercial opportunities',
  Settings: 'Manage workspace configuration and campaign foundations',
  'AI Settings': 'Configure approved AI providers and models',
  Admin: 'Manage platform access and administration',
  'Data Quality': 'Review and resolve lead data issues',
}

function defaultBreadcrumbs(pathname: string, title: string): BreadcrumbItem[] {
  if (pathname === '/dashboard') return []
  let area = 'Workspace'
  if (/\/(leads|lifecycle|deals)/.test(pathname)) area = 'Leads'
  if (/\/(pipeline|dm-queue|email-log|email-report|delivery-failures)/.test(pathname)) area = 'Outreach'
  if (pathname.includes('/settings')) area = 'Settings'
  if (pathname.includes('/admin')) area = 'Platform Admin'
  return [{ label: 'Home', href: '/dashboard' }, { label: area }, ...(title === area ? [] : [{ label: title }])]
}

export default function TopBar({ title, subtitle, actions, breadcrumbs }: TopBarProps) {
  const { toggle } = useSidebar()
  const pathname = usePathname()
  const context = subtitle ?? defaultSubtitles[title]
  return (
    <header className="sticky top-0 z-30 border-b border-[var(--border-subtle)] bg-white/90 px-[var(--page-gutter)] backdrop-blur-xl">
      <div className="mx-auto flex min-h-[4.75rem] max-w-[96rem] items-center justify-between gap-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <button onClick={toggle} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-[var(--border)] bg-white text-[var(--text-secondary)] shadow-sm hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] md:hidden" aria-label="Open menu" aria-controls="app-sidebar"><Menu size={18} /></button>
          <div className="min-w-0">
            <Breadcrumbs items={breadcrumbs ?? defaultBreadcrumbs(pathname, title)} />
            <h1 className="truncate text-lg font-semibold tracking-[-0.02em] text-[var(--text-primary)] md:text-xl">{title}</h1>
            {context && <p className="hidden truncate text-xs text-[var(--text-muted)] sm:block">{context}</p>}
          </div>
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
    </header>
  )
}
