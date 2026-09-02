'use client'

import { createContext, useCallback, useContext, useEffect, useState } from 'react'

const SIDEBAR_COLLAPSED_KEY = 'reachagent.sidebar.collapsed'

interface SidebarContextValue {
  open: boolean
  collapsed: boolean
  toggle: () => void
  close: () => void
  toggleCollapsed: () => void
}

const SidebarContext = createContext<SidebarContextValue>({
  open: false,
  collapsed: false,
  toggle: () => {},
  close: () => {},
  toggleCollapsed: () => {},
})

export function SidebarProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  const [collapsed, setCollapsed] = useState(false)

  useEffect(() => {
    setCollapsed(window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true')
  }, [])

  const toggle = useCallback(() => setOpen((v) => !v), [])
  const close = useCallback(() => setOpen(false), [])
  const toggleCollapsed = useCallback(() => {
    setCollapsed((value) => {
      const next = !value
      window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(next))
      return next
    })
  }, [])
  return (
    <SidebarContext.Provider value={{ open, collapsed, toggle, close, toggleCollapsed }}>
      {children}
    </SidebarContext.Provider>
  )
}

export function useSidebar() {
  return useContext(SidebarContext)
}
