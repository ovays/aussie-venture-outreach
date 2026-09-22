'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronLeft, ChevronRight, LogOut, Shield, X } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import type { UserRole } from '@/lib/auth-types'
import { Avatar } from '@/components/ui/Avatar'
import { WorkspaceSwitcher } from './WorkspaceSwitcher'
import { useSidebar } from './SidebarContext'
import { adminNavigation, isAdminRoute, isRouteActive, isSectionActive, navigationSections, type NavigationItem } from './navigation'

function NavLink({ item, active, collapsed, onNavigate }: { item: NavigationItem; active: boolean; collapsed: boolean; onNavigate: () => void }) {
  const Icon = item.icon
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      aria-label={collapsed ? item.label : undefined}
      title={collapsed ? item.label : undefined}
      className={`group relative flex min-h-9 items-center rounded-lg text-[13px] font-medium ${collapsed ? 'justify-center px-2' : 'gap-3 px-3'} ${active ? 'bg-white/10 text-white shadow-sm' : 'text-slate-400 hover:bg-white/[0.065] hover:text-slate-100'}`}
    >
      {active && <span className="absolute inset-y-2 left-0 w-0.5 rounded-r-full bg-indigo-400" />}
      <Icon size={16} strokeWidth={1.8} className="shrink-0" aria-hidden="true" />
      {!collapsed && <span className="truncate">{item.label}</span>}
      {collapsed && <span className="pointer-events-none absolute left-[calc(100%+0.625rem)] z-[70] hidden whitespace-nowrap rounded-lg bg-slate-950 px-2.5 py-1.5 text-xs text-white shadow-xl group-hover:block group-focus-visible:block">{item.label}</span>}
    </Link>
  )
}

interface SidebarProps {
  role: UserRole
  userName?: string | null
  userEmail?: string | null
  workspaceName: string
}

export default function Sidebar({ role, userName, userEmail, workspaceName }: SidebarProps) {
  const pathname = usePathname()
  const router = useRouter()
  const { open, collapsed, close, toggleCollapsed } = useSidebar()
  const [desktop, setDesktop] = useState(false)
  const [openSections, setOpenSections] = useState<Set<string>>(() => new Set())
  const [adminOpen, setAdminOpen] = useState(false)
  const closeButtonRef = useRef<HTMLButtonElement>(null)

  const activeSection = useMemo(
    () => navigationSections.find((section) => section.label !== 'Campaigns' && isSectionActive(pathname, section))?.label,
    [pathname],
  )

  useEffect(() => {
    if (activeSection) setOpenSections((current) => new Set([...current, activeSection]))
    if (isAdminRoute(pathname)) setAdminOpen(true)
  }, [activeSection, pathname])

  useEffect(() => {
    const media = window.matchMedia('(min-width: 768px)')
    const update = () => setDesktop(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  useEffect(() => { close() }, [pathname, close])

  useEffect(() => {
    if (!open) return
    closeButtonRef.current?.focus()
    const handleKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') close() }
    document.addEventListener('keydown', handleKeyDown)
    document.body.style.overflow = 'hidden'
    return () => { document.removeEventListener('keydown', handleKeyDown); document.body.style.overflow = '' }
  }, [open, close])

  const handleNavigate = useCallback(() => close(), [close])
  const isCompact = collapsed && !open

  function toggleSection(label: string) {
    setOpenSections((current) => {
      const next = new Set(current)
      if (next.has(label)) next.delete(label)
      else next.add(label)
      return next
    })
  }

  async function handleSignOut() {
    await createClient().auth.signOut()
    close()
    router.push('/login')
  }

  return (
    <>
      <button type="button" className={`fixed inset-0 z-40 bg-slate-950/60 backdrop-blur-sm transition-opacity md:hidden ${open ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0'}`} onClick={close} aria-label="Close navigation" aria-hidden={!open} tabIndex={open ? 0 : -1} />
      <aside
        id="app-sidebar"
        aria-label="Primary navigation"
        aria-hidden={!desktop && !open}
        inert={!desktop && !open ? true : undefined}
        className={`fixed inset-y-0 left-0 z-50 flex h-dvh w-[min(19rem,calc(100vw-1.5rem))] flex-col bg-[var(--sidebar)] text-white shadow-2xl transition-[width,transform] duration-200 ease-out ${open ? 'translate-x-0' : '-translate-x-full'} md:relative md:inset-auto md:translate-x-0 md:shadow-none ${collapsed ? 'md:w-[4.5rem]' : 'md:w-64'}`}
      >
        <div className={`flex min-h-17 items-center ${isCompact ? 'justify-center px-2' : 'justify-between px-4'}`}>
          <Link href="/dashboard" onClick={handleNavigate} className={`flex min-w-0 items-center ${isCompact ? '' : 'gap-3'}`} aria-label="ReachAgent home">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-indigo-500 text-sm font-black text-white shadow-[0_8px_22px_rgb(79_70_229_/_35%)]">R</span>
            {!isCompact && <span className="min-w-0"><span className="block truncate text-sm font-semibold tracking-tight">ReachAgent</span><span className="block truncate text-[10px] font-medium uppercase tracking-[0.14em] text-slate-500">Outreach workspace</span></span>}
          </Link>
          <button ref={closeButtonRef} onClick={close} className="flex h-10 w-10 items-center justify-center rounded-lg text-slate-400 hover:bg-white/10 hover:text-white md:hidden" aria-label="Close menu"><X size={18} /></button>
        </div>

        <div className={isCompact ? 'px-2 pb-3' : 'px-3 pb-3'}><WorkspaceSwitcher name={workspaceName} compact={isCompact} /></div>

        <nav className={`flex-1 overflow-y-auto py-2 ${isCompact ? 'px-2' : 'px-3'}`}>
          <div className="space-y-1">
            {navigationSections.map((section) => {
              const Icon = section.icon
              const active = section.label !== 'Campaigns' && isSectionActive(pathname, section)
              if (section.href) return <NavLink key={section.label} item={{ href: section.href, label: section.label, icon: section.icon, exact: true }} active={active} collapsed={isCompact} onNavigate={handleNavigate} />
              const visibleItems = section.items?.filter((item) => !item.adminOnly || role === 'admin') ?? []
              const expanded = openSections.has(section.label)
              if (isCompact) {
                const first = visibleItems[0]
                if (!first) return null
                return <NavLink key={section.label} item={{ ...first, label: section.label, icon: section.icon }} active={active} collapsed onNavigate={handleNavigate} />
              }
              return (
                <div key={section.label}>
                  <button type="button" onClick={() => toggleSection(section.label)} aria-expanded={expanded} aria-controls={`nav-${section.label.toLowerCase()}`} className={`flex min-h-10 w-full items-center gap-3 rounded-lg px-3 text-sm font-medium ${active ? 'text-white' : 'text-slate-400 hover:bg-white/[0.065] hover:text-white'}`}>
                    <Icon size={17} strokeWidth={1.8} aria-hidden="true" /><span className="flex-1 text-left">{section.label}</span><ChevronDown size={14} className={`transition-transform ${expanded ? 'rotate-180' : ''}`} aria-hidden="true" />
                  </button>
                  <div id={`nav-${section.label.toLowerCase()}`} className={`grid transition-[grid-template-rows,opacity] ${expanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}><div className="overflow-hidden"><div className="ml-[1.15rem] space-y-0.5 border-l border-white/10 py-1 pl-3">{visibleItems.map((item) => <NavLink key={item.href} item={item} active={active && isRouteActive(pathname, item.href, item.exact)} collapsed={false} onNavigate={handleNavigate} />)}</div></div></div>
                </div>
              )
            })}
          </div>

          {role === 'admin' && <section className="mt-5 border-t border-white/10 pt-4">
            {!isCompact && <p className="mb-1.5 px-3 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-600">Platform</p>}
            <button type="button" onClick={() => setAdminOpen((value) => !value)} aria-expanded={adminOpen} aria-controls="admin-navigation" title={isCompact ? 'Platform admin' : undefined} className={`flex min-h-10 w-full items-center rounded-lg text-sm font-medium ${isCompact ? 'justify-center px-2' : 'gap-3 px-3'} ${isAdminRoute(pathname) ? 'text-white' : 'text-slate-400 hover:bg-white/[0.065] hover:text-white'}`}><Shield size={17} />{!isCompact && <><span className="flex-1 text-left">Platform Admin</span><ChevronDown size={14} className={adminOpen ? 'rotate-180' : ''} /></>}</button>
            {!isCompact && <div id="admin-navigation" className={`grid transition-[grid-template-rows,opacity] ${adminOpen ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}><div className="overflow-hidden"><div className="ml-[1.15rem] space-y-0.5 border-l border-white/10 py-1 pl-3">{adminNavigation.map((item) => <NavLink key={item.href} item={item} active={isRouteActive(pathname, item.href, item.exact)} collapsed={false} onNavigate={handleNavigate} />)}</div></div></div>}
          </section>}
        </nav>

        <div className={`border-t border-white/10 py-3 ${isCompact ? 'px-2' : 'px-3'}`}>
          <div className={`flex items-center rounded-xl ${isCompact ? 'justify-center p-1' : 'gap-3 px-2 py-2'}`}>
            <Avatar name={userName} email={userEmail} size="sm" />
            {!isCompact && <div className="min-w-0 flex-1"><p className="truncate text-xs font-semibold text-slate-100">{userName || userEmail || 'Account'}</p><p className="truncate text-[10px] capitalize text-slate-500">{role === 'admin' ? 'Platform admin' : 'Workspace member'}</p></div>}
            <button type="button" onClick={handleSignOut} title="Sign out" aria-label="Sign out" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-red-500/10 hover:text-red-300"><LogOut size={15} /></button>
          </div>
        </div>

        <button type="button" onClick={toggleCollapsed} className="absolute -right-3 top-[5.35rem] hidden h-7 w-7 items-center justify-center rounded-full border border-[var(--border)] bg-white text-[var(--text-secondary)] shadow-sm hover:text-[var(--primary)] md:flex" aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>{collapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}</button>
      </aside>
    </>
  )
}
