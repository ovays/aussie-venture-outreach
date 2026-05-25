'use client'

import { createContext, useContext, useState, useCallback } from 'react'
import type { ReactNode } from 'react'

interface LeadDrawerContextValue {
  leadId: string | null
  openDrawer: (id: string) => void
  closeDrawer: () => void
  refreshKey: number
  triggerRefresh: () => void
}

const LeadDrawerContext = createContext<LeadDrawerContextValue | null>(null)

export function LeadDrawerProvider({ children }: { children: ReactNode }) {
  const [leadId, setLeadId] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  const openDrawer = useCallback((id: string) => setLeadId(id), [])
  const closeDrawer = useCallback(() => setLeadId(null), [])
  const triggerRefresh = useCallback(() => setRefreshKey((k) => k + 1), [])

  return (
    <LeadDrawerContext.Provider value={{ leadId, openDrawer, closeDrawer, refreshKey, triggerRefresh }}>
      {children}
    </LeadDrawerContext.Provider>
  )
}

export function useLeadDrawer() {
  const ctx = useContext(LeadDrawerContext)
  if (!ctx) throw new Error('useLeadDrawer must be used within LeadDrawerProvider')
  return ctx
}
