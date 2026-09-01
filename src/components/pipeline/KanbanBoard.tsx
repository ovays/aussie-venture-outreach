'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { KanbanCard } from './KanbanCard'
import { useLeadDrawer } from '@/lib/lead-drawer-context'
import { STAGE_STATUSES } from '@/lib/lead-status'
import { Search } from 'lucide-react'
import { SEARCH_DEBOUNCE_MS } from '@/lib/search'

interface Lead {
  id: string
  business_name: string
  category_name: string
  city: string
  suburb: string | null
  status: string
  deal_value: number | null
  created_at: string
}

const COLUMNS = [
  { key: 'new', label: 'New', color: '#60a5fa', statuses: ['new'] as string[] },
  { key: 'contacted', label: 'Contacted', color: '#fb923c', statuses: STAGE_STATUSES.contacted as string[] },
  { key: 'replied', label: 'Replied 🔥', color: '#4ade80', statuses: STAGE_STATUSES.replied as string[] },
  { key: 'negotiating', label: 'Negotiating', color: '#2dd4bf', statuses: STAGE_STATUSES.negotiating as string[] },
  { key: 'closed', label: 'Closed ✅', color: '#34d399', statuses: STAGE_STATUSES.closed as string[] },
  { key: 'dead', label: 'Dead ❌', color: '#6b7280', statuses: STAGE_STATUSES.dead as string[] },
] as const

interface ColumnState {
  leads: Lead[]
  total: number
  page: number
  loading: boolean
  error: string | null
}

const emptyColumn = (): ColumnState => ({ leads: [], total: 0, page: 0, loading: true, error: null })

export function KanbanBoard() {
  const { openDrawer } = useLeadDrawer()
  const [columns, setColumns] = useState<Record<string, ColumnState>>(
    () => Object.fromEntries(COLUMNS.map(({ key }) => [key, emptyColumn()])),
  )
  const controllers = useRef(new Map<string, AbortController>())
  const mutations = useRef(new Set<string>())
  const [mutatingLeadIds, setMutatingLeadIds] = useState<ReadonlySet<string>>(() => new Set())
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')

  const cleanupMutation = useCallback((leadId: string) => {
    mutations.current.delete(leadId)
    setMutatingLeadIds((current) => {
      if (!current.has(leadId)) return current
      const next = new Set(current)
      next.delete(leadId)
      return next
    })
  }, [])

  const loadColumn = useCallback(async (key: string, page = 1) => {
    controllers.current.get(key)?.abort()
    const controller = new AbortController()
    controllers.current.set(key, controller)
    setColumns((current) => ({
      ...current,
      [key]: { ...current[key], loading: true, error: null },
    }))
    try {
      const params = new URLSearchParams({ stage: key, page: String(page), page_size: '50' })
      if (debouncedSearch) params.set('search', debouncedSearch)
      const response = await fetch(`/api/pipeline?${params}`, { signal: controller.signal })
      const json = await response.json() as { data?: Lead[]; total?: number; error?: string }
      if (!response.ok) throw new Error(json.error ?? 'Pipeline request failed')
      setColumns((current) => ({
        ...current,
        [key]: {
          leads: page === 1 ? (json.data ?? []) : [...current[key].leads, ...(json.data ?? [])],
          total: json.total ?? 0,
          page,
          loading: false,
          error: null,
        },
      }))
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      setColumns((current) => ({
        ...current,
        [key]: { ...current[key], loading: false, error: error instanceof Error ? error.message : 'Pipeline request failed' },
      }))
    }
  }, [debouncedSearch])

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [search])

  useEffect(() => {
    for (const { key } of COLUMNS) void loadColumn(key)
    const activeControllers = controllers.current
    return () => activeControllers.forEach((controller) => controller.abort())
  }, [loadColumn])

  async function moveCard(leadId: string, destination: string) {
    if (mutations.current.has(leadId)) return
    const source = COLUMNS.find(({ key }) => columns[key].leads.some((lead) => lead.id === leadId))?.key
    if (!source || source === destination) return
    const lead = columns[source].leads.find((item) => item.id === leadId)
    if (!lead) return

    mutations.current.add(leadId)
    setMutatingLeadIds((current) => new Set(current).add(leadId))
    setColumns((current) => ({
      ...current,
      [source]: { ...current[source], leads: current[source].leads.filter((item) => item.id !== leadId), total: Math.max(0, current[source].total - 1) },
      [destination]: { ...current[destination], leads: [{ ...lead, status: destination }, ...current[destination].leads], total: current[destination].total + 1 },
    }))

    try {
      try {
        const response = await fetch('/api/leads', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: leadId, status: destination }),
        })
        if (!response.ok) {
          const json = await response.json() as { error?: string }
          throw new Error(json.error ?? 'Could not move lead')
        }
        cleanupMutation(leadId)
      } catch {
        setColumns((current) => {
          const sourceHasLead = current[source].leads.some((item) => item.id === leadId)
          const destinationHasLead = current[destination].leads.some((item) => item.id === leadId)

          return {
            ...current,
            [source]: sourceHasLead
              ? current[source]
              : { ...current[source], leads: [lead, ...current[source].leads], total: current[source].total + 1 },
            [destination]: destinationHasLead
              ? { ...current[destination], leads: current[destination].leads.filter((item) => item.id !== leadId), total: Math.max(0, current[destination].total - 1) }
              : current[destination],
          }
        })
        return
      }

      await Promise.all([loadColumn(source), loadColumn(destination)])
    } finally {
      cleanupMutation(leadId)
    }
  }

  return (
    <>
      <div className="border-b px-3 py-3 md:px-6" style={{ borderColor: '#2a2d3e' }}>
        <div className="relative w-full max-w-sm">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2" style={{ color: '#64748b' }} />
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search business, email or domain..." aria-label="Search business, email or domain" className="w-full rounded-lg py-2 pl-9 pr-3 text-sm text-white outline-none" style={{ background: '#0f1117', border: '1px solid #2a2d3e' }} />
        </div>
      </div>
      <div className="flex gap-3 overflow-x-auto pb-4 p-3 md:p-6 min-h-0 flex-1 snap-x snap-mandatory">
      {COLUMNS.map(({ key, label, color }) => {
        const column = columns[key]
        return (
          <div key={key} className="flex flex-col rounded-xl shrink-0 w-[82vw] md:w-64 snap-center" style={{ background: '#1e2130', border: '1px solid #2a2d3e' }} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const id = event.dataTransfer.getData('text/plain'); if (id) void moveCard(id, key) }}>
            <div className="flex items-center justify-between px-4 py-3 border-b rounded-t-xl" style={{ borderColor: '#2a2d3e', borderTop: `3px solid ${color}` }}>
              <h3 className="text-sm font-semibold" style={{ color }}>{label}</h3>
              <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ background: `${color}20`, color }}>{column.total}</span>
            </div>
            <div className="flex-1 p-3 space-y-2 overflow-y-auto">
              {column.leads.map((lead) => (
                <div key={lead.id} draggable={!mutatingLeadIds.has(lead.id)} onDragStart={(event) => event.dataTransfer.setData('text/plain', lead.id)}>
                  <KanbanCard lead={lead} onClick={() => openDrawer(lead.id)} />
                </div>
              ))}
              {column.loading && column.leads.length === 0 && <p className="text-xs text-center py-4" style={{ color: '#64748b' }}>Loading…</p>}
              {column.error && <p className="text-xs text-center py-4" style={{ color: '#f87171' }}>{column.error}</p>}
              {!column.loading && !column.error && column.leads.length === 0 && <p className="text-xs text-center py-4" style={{ color: '#475569' }}>No leads</p>}
              {!column.error && column.leads.length < column.total && (
                <button type="button" disabled={column.loading} onClick={() => void loadColumn(key, column.page + 1)} className="w-full py-2 rounded-lg text-xs disabled:opacity-50" style={{ border: '1px solid #2a2d3e', color: '#64748b' }}>
                  {column.loading ? 'Loading…' : `Load more (${column.leads.length} of ${column.total})`}
                </button>
              )}
            </div>
          </div>
        )
      })}
      </div>
    </>
  )
}
