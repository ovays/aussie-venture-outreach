'use client'

import { useState, useEffect } from 'react'
import { Search } from 'lucide-react'
import { Toggle } from '@/components/ui/Toggle'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { formatDate, formatCurrency } from '@/lib/utils'
import { SEARCH_DEBOUNCE_MS } from '@/lib/search'

interface Deal {
  id: string
  deal_value: number
  deal_type: 'visit_content' | 'remote_sponsored' | 'remote_content'
  content_created: boolean
  payment_received: boolean
  notes: string | null
  closed_at: string
  leads: { business_name: string; category_name: string; city: string; suburb: string | null; email: string | null } | null
}

interface DealSummary {
  total_revenue: number
  month_revenue: number
  week_revenue: number
  average_value: number
  total_deals: number
}

const EMPTY_SUMMARY: DealSummary = { total_revenue: 0, month_revenue: 0, week_revenue: 0, average_value: 0, total_deals: 0 }

const DEAL_TYPE_LABELS: Record<string, string> = {
  visit_content: 'Visit + Content',
  remote_sponsored: 'Remote Sponsored',
  remote_content: 'Remote Content',
}

export function DealsTable() {
  const [deals, setDeals] = useState<Deal[]>([])
  const [loading, setLoading] = useState(true)
  const [editingDeal, setEditingDeal] = useState<Deal | null>(null)
  const [editNotes, setEditNotes] = useState('')
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [summary, setSummary] = useState<DealSummary>(EMPTY_SUMMARY)

  useEffect(() => {
    const timer = setTimeout(() => {
      setPage(1)
      setDebouncedSearch(search.trim())
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [search])

  useEffect(() => {
    const controller = new AbortController()
    async function fetchDeals() {
      setLoading(true)
      const params = new URLSearchParams({ page: String(page), page_size: '50' })
      if (debouncedSearch) params.set('search', debouncedSearch)
      const res = await fetch(`/api/deals?${params}`, { signal: controller.signal })
      const json = await res.json() as { data: Deal[]; total?: number; summary?: Partial<DealSummary> }
      setDeals(json.data ?? [])
      setTotal(json.total ?? 0)
      setSummary({ ...EMPTY_SUMMARY, ...json.summary })
      setLoading(false)
    }
    void fetchDeals().catch((error) => {
      if (!(error instanceof DOMException && error.name === 'AbortError')) setLoading(false)
    })
    return () => controller.abort()
  }, [debouncedSearch, page])

  async function toggleDeal(id: string, field: 'content_created' | 'payment_received', value: boolean) {
    await fetch('/api/deals', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, [field]: value, [`${field}_at`]: value ? new Date().toISOString() : null }),
    })
    setDeals((prev) => prev.map((d) => d.id === id ? { ...d, [field]: value } : d))
  }

  async function saveNotes() {
    if (!editingDeal) return
    await fetch('/api/deals', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: editingDeal.id, notes: editNotes }),
    })
    setDeals((prev) => prev.map((d) => d.id === editingDeal.id ? { ...d, notes: editNotes } : d))
    setEditingDeal(null)
  }

  const totalPages = Math.max(1, Math.ceil(total / 50))

  return (
    <div>
      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4 p-5 border-b" style={{ borderColor: '#2a2d3e' }}>
        {[
          { label: 'Total Revenue', value: formatCurrency(summary.total_revenue), color: '#fbbf24' },
          { label: 'This Month', value: formatCurrency(summary.month_revenue), color: '#4ade80' },
          { label: 'This Week', value: formatCurrency(summary.week_revenue), color: '#38bdf8' },
          { label: 'Avg Deal', value: formatCurrency(summary.average_value), color: '#a78bfa' },
          { label: 'Total Deals', value: summary.total_deals, color: '#e2e8f0' },
        ].map(({ label, value, color }) => (
          <div key={label}>
            <p className="text-xs" style={{ color: '#64748b' }}>{label}</p>
            <p className="text-xl font-bold mt-0.5" style={{ color }}>{value}</p>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-3 border-b px-4 py-3" style={{ borderColor: '#2a2d3e' }}>
        <div className="relative w-full max-w-sm">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2" style={{ color: '#64748b' }} />
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search business, email or domain..." aria-label="Search business, email or domain" className="w-full rounded-lg py-2 pl-9 pr-3 text-sm text-white outline-none" style={{ background: '#0f1117', border: '1px solid #2a2d3e' }} />
        </div>
        <span className="ml-auto whitespace-nowrap text-xs" style={{ color: '#64748b' }}>{total} matching</span>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr style={{ borderBottom: '1px solid #2a2d3e' }}>
              {['Business', 'Type', 'Value', 'Content', 'Payment', 'Closed', 'Actions'].map((h) => (
                <th key={h} className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider" style={{ color: '#64748b' }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={7} className="px-4 py-12 text-center" style={{ color: '#64748b' }}>Loading...</td></tr>
            ) : deals.length === 0 ? (
              <tr><td colSpan={7} className="px-4 py-12 text-center" style={{ color: '#64748b' }}>No deals yet</td></tr>
            ) : (
              deals.map((deal) => (
                <tr key={deal.id} className="border-b" style={{ borderColor: '#1e2130' }}>
                  <td className="px-4 py-3">
                    <div className="font-medium text-white">{deal.leads?.business_name ?? '—'}</div>
                    <div className="text-xs mt-0.5" style={{ color: '#64748b' }}>
                      {[deal.leads?.suburb, deal.leads?.city].filter(Boolean).join(', ')}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-xs px-2 py-1 rounded-full" style={{ background: '#2a2d3e', color: '#94a3b8' }}>
                      {DEAL_TYPE_LABELS[deal.deal_type]}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-semibold" style={{ color: '#4ade80' }}>
                    {formatCurrency(deal.deal_value)}
                  </td>
                  <td className="px-4 py-3">
                    <Toggle
                      checked={deal.content_created}
                      onChange={(v) => toggleDeal(deal.id, 'content_created', v)}
                    />
                  </td>
                  <td className="px-4 py-3">
                    <Toggle
                      checked={deal.payment_received}
                      onChange={(v) => toggleDeal(deal.id, 'payment_received', v)}
                    />
                  </td>
                  <td className="px-4 py-3 text-xs" style={{ color: '#64748b' }}>{formatDate(deal.closed_at)}</td>
                  <td className="px-4 py-3">
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => { setEditingDeal(deal); setEditNotes(deal.notes ?? '') }}
                    >
                      Edit
                    </Button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between border-t p-4" style={{ borderColor: '#2a2d3e' }}>
        <Button size="sm" variant="secondary" disabled={page <= 1 || loading} onClick={() => setPage((value) => value - 1)}>Previous</Button>
        <span className="text-xs" style={{ color: '#64748b' }}>Page {page} of {totalPages}</span>
        <Button size="sm" variant="secondary" disabled={page >= totalPages || loading} onClick={() => setPage((value) => value + 1)}>Next</Button>
      </div>

      {/* Edit Notes Modal */}
      <Modal
        open={!!editingDeal}
        onClose={() => setEditingDeal(null)}
        title={`Edit — ${editingDeal?.leads?.business_name ?? ''}`}
      >
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1.5" style={{ color: '#94a3b8' }}>Notes</label>
            <textarea
              value={editNotes}
              onChange={(e) => setEditNotes(e.target.value)}
              rows={5}
              className="w-full px-3 py-2 rounded-lg text-sm text-white outline-none focus:ring-2 focus:ring-sky-500 resize-none"
              style={{ background: '#0f1117', border: '1px solid #2a2d3e' }}
            />
          </div>
          <div className="flex gap-2 justify-end">
            <Button variant="ghost" onClick={() => setEditingDeal(null)}>Cancel</Button>
            <Button onClick={saveNotes}>Save</Button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
