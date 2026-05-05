'use client'

import { useState, useEffect, useCallback } from 'react'
import { Search, Star, AtSign, Mail } from 'lucide-react'
import { StatusBadge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { LeadDetailPanel } from './LeadDetailPanel'
import { formatDate } from '@/lib/utils'

interface Lead {
  id: string
  business_name: string
  category_name: string
  city: string
  suburb: string | null
  email: string | null
  phone: string | null
  website: string | null
  instagram_handle: string | null
  google_rating: number | null
  status: string
  deal_value: number | null
  deal_type: string | null
  content_created: boolean
  payment_received: boolean
  notes: string | null
  created_at: string
  halal: boolean
  description: string | null
  services: string | null
}

const STATUS_OPTIONS = ['new', 'researched', 'email_ready', 'contacted', 'replied', 'negotiating', 'closed', 'dead']
const CITIES = ['Sydney', 'Melbourne', 'Brisbane', 'Perth', 'Adelaide']

interface LeadsTableProps {
  initialStatus?: string
}

export function LeadsTable({ initialStatus }: LeadsTableProps) {
  const [leads, setLeads] = useState<Lead[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [selectedLead, setSelectedLead] = useState<Lead | null>(null)

  const [search, setSearch] = useState('')
  const [status, setStatus] = useState(initialStatus ?? '')
  const [city, setCity] = useState('')

  const fetchLeads = useCallback(async () => {
    setLoading(true)
    const params = new URLSearchParams({ page: String(page) })
    if (search) params.set('search', search)
    if (status) params.set('status', status)
    if (city) params.set('city', city)

    const res = await fetch(`/api/leads?${params}`)
    const json = await res.json() as { data: Lead[]; count: number }
    setLeads(json.data ?? [])
    setTotal(json.count ?? 0)
    setLoading(false)
  }, [page, search, status, city])

  useEffect(() => { fetchLeads() }, [fetchLeads])

  function updateLead(id: string, updates: Partial<Lead>) {
    setLeads((prev) => prev.map((l) => l.id === id ? { ...l, ...updates } : l))
    if (selectedLead?.id === id) setSelectedLead((prev) => prev ? { ...prev, ...updates } : prev)
  }

  const totalPages = Math.ceil(total / 50)

  return (
    <div className="relative">
      {/* Filters */}
      <div className="flex flex-col sm:flex-row flex-wrap gap-2 p-3 md:p-4 border-b" style={{ borderColor: '#2a2d3e' }}>
        {/* Search — full width on mobile */}
        <div
          className="flex items-center gap-2 w-full sm:flex-1 sm:min-w-48 px-3 py-2 rounded-lg"
          style={{ background: '#0f1117', border: '1px solid #2a2d3e' }}
        >
          <Search size={14} style={{ color: '#64748b' }} />
          <input
            type="text"
            placeholder="Search business name..."
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1) }}
            className="flex-1 bg-transparent text-sm text-white placeholder-gray-500 outline-none min-w-0"
          />
        </div>

        {/* Selects + clear */}
        <div className="flex flex-wrap gap-2 items-center">
          <select
            value={status}
            onChange={(e) => { setStatus(e.target.value); setPage(1) }}
            className="px-3 py-2 rounded-lg text-sm text-white outline-none"
            style={{ background: '#0f1117', border: '1px solid #2a2d3e' }}
          >
            <option value="">All Statuses</option>
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>

          <select
            value={city}
            onChange={(e) => { setCity(e.target.value); setPage(1) }}
            className="px-3 py-2 rounded-lg text-sm text-white outline-none"
            style={{ background: '#0f1117', border: '1px solid #2a2d3e' }}
          >
            <option value="">All Cities</option>
            {CITIES.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>

          {(search || status || city) && (
            <Button variant="ghost" size="sm" onClick={() => { setSearch(''); setStatus(''); setCity(''); setPage(1) }}>
              Clear
            </Button>
          )}

          <span className="text-sm ml-auto sm:ml-0" style={{ color: '#64748b' }}>{total} leads</span>
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr style={{ borderBottom: '1px solid #2a2d3e' }}>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider" style={{ color: '#64748b' }}>Business</th>
              <th className="hidden md:table-cell px-4 py-3 text-left text-xs font-medium uppercase tracking-wider" style={{ color: '#64748b' }}>Category</th>
              <th className="hidden md:table-cell px-4 py-3 text-left text-xs font-medium uppercase tracking-wider" style={{ color: '#64748b' }}>Location</th>
              <th className="hidden md:table-cell px-4 py-3 text-left text-xs font-medium uppercase tracking-wider" style={{ color: '#64748b' }}>Contact</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider" style={{ color: '#64748b' }}>Status</th>
              <th className="hidden md:table-cell px-4 py-3 text-left text-xs font-medium uppercase tracking-wider" style={{ color: '#64748b' }}>Rating</th>
              <th className="hidden md:table-cell px-4 py-3 text-left text-xs font-medium uppercase tracking-wider" style={{ color: '#64748b' }}>Added</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider" style={{ color: '#64748b' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={8} className="px-4 py-12 text-center" style={{ color: '#64748b' }}>Loading...</td>
              </tr>
            ) : leads.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-12 text-center" style={{ color: '#64748b' }}>No leads found</td>
              </tr>
            ) : (
              leads.map((lead) => (
                <tr
                  key={lead.id}
                  className="border-b cursor-pointer transition-colors hover:bg-white/2"
                  style={{ borderColor: '#1e2130' }}
                  onClick={() => setSelectedLead(lead)}
                >
                  <td className="px-4 py-3">
                    <span className="font-medium text-white">{lead.business_name}</span>
                    {lead.halal && <span className="ml-1.5 text-xs text-green-400">Halal</span>}
                  </td>
                  <td className="hidden md:table-cell px-4 py-3" style={{ color: '#94a3b8' }}>{lead.category_name}</td>
                  <td className="hidden md:table-cell px-4 py-3" style={{ color: '#94a3b8' }}>
                    {[lead.suburb, lead.city].filter(Boolean).join(', ')}
                  </td>
                  <td className="hidden md:table-cell px-4 py-3">
                    <div className="flex items-center gap-2">
                      {lead.email && <span title={lead.email}><Mail size={13} className="text-sky-400" /></span>}
                      {lead.instagram_handle && <span title={lead.instagram_handle}><AtSign size={13} className="text-pink-400" /></span>}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={lead.status} />
                  </td>
                  <td className="hidden md:table-cell px-4 py-3">
                    {lead.google_rating ? (
                      <span className="flex items-center gap-1" style={{ color: '#fbbf24' }}>
                        <Star size={11} fill="#fbbf24" />
                        {lead.google_rating}
                      </span>
                    ) : <span style={{ color: '#64748b' }}>—</span>}
                  </td>
                  <td className="hidden md:table-cell px-4 py-3 text-xs" style={{ color: '#64748b' }}>{formatDate(lead.created_at)}</td>
                  <td className="px-4 py-3">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={(e) => { e.stopPropagation(); setSelectedLead(lead) }}
                    >
                      View
                    </Button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 p-4">
          <Button variant="secondary" size="sm" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}>
            Prev
          </Button>
          <span className="text-sm" style={{ color: '#94a3b8' }}>Page {page} of {totalPages}</span>
          <Button variant="secondary" size="sm" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page === totalPages}>
            Next
          </Button>
        </div>
      )}

      {/* Detail Panel */}
      {selectedLead && (
        <LeadDetailPanel
          lead={selectedLead}
          onClose={() => setSelectedLead(null)}
          onUpdate={updateLead}
        />
      )}
    </div>
  )
}
