'use client'

import { useState, useEffect } from 'react'
import { Toggle } from '@/components/ui/Toggle'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { formatDate, formatCurrency } from '@/lib/utils'

interface Deal {
  id: string
  deal_value: number
  deal_type: 'visit_content' | 'remote_sponsored' | 'remote_content'
  content_created: boolean
  payment_received: boolean
  notes: string | null
  closed_at: string
  leads: { business_name: string; category_name: string; city: string; suburb: string | null } | null
}

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

  useEffect(() => {
    async function fetchDeals() {
      setLoading(true)
      const res = await fetch('/api/deals')
      const json = await res.json() as { data: Deal[] }
      setDeals(json.data ?? [])
      setLoading(false)
    }
    fetchDeals()
  }, [])

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

  const totalRevenue = deals.reduce((s, d) => s + d.deal_value, 0)
  const now = Date.now()
  const thisMonth = deals.filter((d) => now - new Date(d.closed_at).getTime() < 30 * 86_400_000)
  const thisWeek = deals.filter((d) => now - new Date(d.closed_at).getTime() < 7 * 86_400_000)
  const avgValue = deals.length > 0 ? totalRevenue / deals.length : 0

  return (
    <div>
      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4 p-5 border-b" style={{ borderColor: '#2a2d3e' }}>
        {[
          { label: 'Total Revenue', value: formatCurrency(totalRevenue), color: '#fbbf24' },
          { label: 'This Month', value: formatCurrency(thisMonth.reduce((s, d) => s + d.deal_value, 0)), color: '#4ade80' },
          { label: 'This Week', value: formatCurrency(thisWeek.reduce((s, d) => s + d.deal_value, 0)), color: '#38bdf8' },
          { label: 'Avg Deal', value: formatCurrency(avgValue), color: '#a78bfa' },
          { label: 'Total Deals', value: deals.length, color: '#e2e8f0' },
        ].map(({ label, value, color }) => (
          <div key={label}>
            <p className="text-xs" style={{ color: '#64748b' }}>{label}</p>
            <p className="text-xl font-bold mt-0.5" style={{ color }}>{value}</p>
          </div>
        ))}
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
