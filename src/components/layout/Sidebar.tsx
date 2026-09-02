'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  LogOut,
  Shield,
  Sparkles,
  X,
} from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import type { UserRole } from '@/lib/auth-types'
import { useSidebar } from './SidebarContext'
import {
  adminNavigation,
  isAdminRoute,
  isRouteActive,
  navigationSections,
  utilityNavigation,
  type NavigationItem,
} from './navigation'

const ADMIN_OPEN_KEY = 'reachagent.admin.open'

function NavLink({
  item,
  active,
  collapsed,
  onNavigate,
}: {
  item: NavigationItem
  active: boolean
  collapsed: boolean
  onNavigate: () => void
}) {
  const Icon = item.icon

  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      aria-label={collapsed ? item.label : undefined}
      title={collapsed ? item.label : undefined}
      className={[
        'group relative flex min-h-10 items-center rounded-xl text-sm font-medium',
        collapsed ? 'justify-center px-2' : 'gap-3 px-3',
        active
          ? 'bg-[var(--primary-muted)] text-[var(--primary)]'
          : 'text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]',
      ].join(' ')}
    >
      {active && <span className="absolute inset-y-2 left-0 w-0.5 rounded-r-full bg-[var(--primary)]" />}
      <Icon size={17} strokeWidth={1.8} className="shrink-0" aria-hidden="true" />
      {!collapsed && <span className="truncate">{item.label}</span>}
      {collapsed && (
        <span className="pointer-events-none absolute left-[calc(100%+0.625rem)] z-[70] hidden whitespace-nowrap rounded-lg border border-[var(--border)] bg-[var(--surface-raised)] px-2.5 py-1.5 text-xs text-[var(--text-primary)] shadow-xl group-hover:block group-focus-visible:block">
          {item.label}
        </span>
      )}
    </Link>
  )
}

export default function Sidebar({ role }: { role: UserRole }) {
  const pathname = usePathname()
  const router = useRouter()
  const { open, collapsed, close, toggleCollapsed } = useSidebar()
  const adminActive = isAdminRoute(pathname)
  const [adminOpen, setAdminOpen] = useState(adminActive)
  const [desktop, setDesktop] = useState(false)
  const closeButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const media = window.matchMedia('(min-width: 768px)')
    const update = () => setDesktop(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    const stored = window.sessionStorage.getItem(ADMIN_OPEN_KEY)
    if (stored !== null) setAdminOpen(stored === 'true' || adminActive)
  }, [adminActive])

  useEffect(() => {
    close()
  }, [pathname, close])

  useEffect(() => {
    if (!open) return
    closeButtonRef.current?.focus()
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('keydown', handleKeyDown)
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = ''
    }
  }, [open, close])

  const handleNavigate = useCallback(() => close(), [close])

  function toggleAdmin() {
    setAdminOpen((value) => {
      const next = !value
      window.sessionStorage.setItem(ADMIN_OPEN_KEY, String(next))
      return next
    })
  }

  async function handleSignOut() {
    const supabase = createClient()
    await supabase.auth.signOut()
    close()
    router.push('/login')
  }

  const isCompact = collapsed && !open

  return (
    <>
      <button
        type="button"
        className={[
          'fixed inset-0 z-40 bg-black/70 backdrop-blur-sm transition-opacity md:hidden',
          open ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0',
        ].join(' ')}
        onClick={close}
        aria-label="Close navigation"
        aria-hidden={!open}
        tabIndex={open ? 0 : -1}
      />

      <aside
        id="app-sidebar"
        aria-label="Primary navigation"
        aria-hidden={!desktop && !open}
        inert={!desktop && !open ? true : undefined}
        className={[
          'fixed inset-y-0 left-0 z-50 flex h-dvh w-[min(19rem,calc(100vw-1.5rem))] flex-col border-r border-[var(--border-subtle)] bg-[var(--sidebar)] shadow-2xl transition-[width,transform] duration-200 ease-out',
          open ? 'translate-x-0' : '-translate-x-full',
          'md:relative md:inset-auto md:translate-x-0 md:shadow-none',
          collapsed ? 'md:w-[4.5rem]' : 'md:w-60',
        ].join(' ')}
      >
        <div className={['flex h-17 items-center border-b border-[var(--border-subtle)]', isCompact ? 'justify-center px-2' : 'justify-between px-4'].join(' ')}>
          <div className={['flex min-w-0 items-center', isCompact ? '' : 'gap-3'].join(' ')}>
            <div className="relative flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-gradient-to-br from-sky-300 via-sky-400 to-cyan-600 text-sm font-black text-slate-950 shadow-[0_0_24px_rgb(56_189_248_/_14%)]">
              R
              <span className="absolute bottom-0 right-0 h-2.5 w-2.5 rounded-tl-lg bg-[var(--sand)]" />
            </div>
            {!isCompact && (
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold tracking-[-0.01em] text-[var(--text-primary)]">ReachAgent</p>
                <p className="truncate text-[10px] font-medium uppercase tracking-[0.14em] text-[var(--text-muted)]">Outreach OS</p>
              </div>
            )}
          </div>
          <button
            ref={closeButtonRef}
            onClick={close}
            className="flex h-11 w-11 items-center justify-center rounded-xl text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] md:hidden"
            aria-label="Close menu"
          >
            <X size={18} />
          </button>
        </div>

        <nav className={['flex-1 overflow-y-auto py-3', isCompact ? 'px-2' : 'px-3'].join(' ')}>
          {navigationSections.map((section, index) => (
            <section key={section.label} aria-labelledby={`nav-${section.label.toLowerCase()}`} className={index ? 'mt-5' : ''}>
              <h2
                id={`nav-${section.label.toLowerCase()}`}
                className={isCompact ? 'sr-only' : 'mb-1.5 px-3 text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)]'}
              >
                {section.label}
              </h2>
              <div className="space-y-0.5">
                {section.items.map((item) => (
                  <NavLink key={item.href} item={item} active={isRouteActive(pathname, item.href)} collapsed={isCompact} onNavigate={handleNavigate} />
                ))}
              </div>
            </section>
          ))}

          {role === 'admin' && (
            <section className="mt-5">
              <button
                type="button"
                onClick={toggleAdmin}
                aria-expanded={adminOpen}
                aria-controls="admin-navigation"
                title={isCompact ? 'Admin' : undefined}
                className={[
                  'group relative flex min-h-10 w-full items-center rounded-xl text-sm font-medium',
                  isCompact ? 'justify-center px-2' : 'gap-3 px-3',
                  adminActive ? 'text-[var(--primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]',
                ].join(' ')}
              >
                <Shield size={17} strokeWidth={1.8} aria-hidden="true" />
                {!isCompact && <span className="flex-1 text-left">Admin</span>}
                {!isCompact && <ChevronDown size={15} className={adminOpen ? 'rotate-180 transition-transform' : 'transition-transform'} />}
                {isCompact && <span className="pointer-events-none absolute left-[calc(100%+0.625rem)] z-[70] hidden rounded-lg border border-[var(--border)] bg-[var(--surface-raised)] px-2.5 py-1.5 text-xs text-[var(--text-primary)] shadow-xl group-hover:block">Admin</span>}
              </button>
              <div
                id="admin-navigation"
                className={[
                  'grid transition-[grid-template-rows,opacity] duration-200',
                  adminOpen ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
                ].join(' ')}
              >
                <div className="overflow-hidden">
                  <div className={['mt-1 space-y-0.5', isCompact ? '' : 'ml-3 border-l border-[var(--border-subtle)] pl-2'].join(' ')}>
                    {adminNavigation.map((item) => (
                      <NavLink key={item.href} item={item} active={isRouteActive(pathname, item.href)} collapsed={isCompact} onNavigate={handleNavigate} />
                    ))}
                  </div>
                </div>
              </div>
            </section>
          )}
        </nav>

        <div className={['border-t border-[var(--border-subtle)] py-3', isCompact ? 'px-2' : 'px-3'].join(' ')}>
          <div className="mb-2 space-y-0.5">
            {utilityNavigation.map((item) => (
              <NavLink key={item.href} item={item} active={isRouteActive(pathname, item.href)} collapsed={isCompact} onNavigate={handleNavigate} />
            ))}
          </div>
          <button
            type="button"
            onClick={handleSignOut}
            title={isCompact ? 'Sign out' : undefined}
            aria-label={isCompact ? 'Sign out' : undefined}
            className={[
              'group relative flex min-h-10 w-full items-center rounded-xl text-sm font-medium text-[var(--text-muted)] hover:bg-[var(--error-muted)] hover:text-[var(--error)]',
              isCompact ? 'justify-center px-2' : 'gap-3 px-3',
            ].join(' ')}
          >
            <LogOut size={17} strokeWidth={1.8} aria-hidden="true" />
            {!isCompact && <span>Sign out</span>}
          </button>
          {!isCompact && (
            <div className="mt-3 flex items-center gap-2 px-3 text-[10px] text-[var(--text-muted)]">
              <Sparkles size={11} className="text-[var(--sand)]" />
              <span>Aussie Venture · v1.0</span>
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={toggleCollapsed}
          className="absolute -right-3 top-[5.35rem] hidden h-7 w-7 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--surface-raised)] text-[var(--text-secondary)] shadow-lg hover:border-[var(--primary-border)] hover:text-[var(--primary)] md:flex"
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
        </button>
      </aside>
    </>
  )
}
