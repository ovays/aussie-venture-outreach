'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { Search, Star, AtSign, Mail, Plus, Send, RefreshCw, Trash2, X, Microscope, Upload } from 'lucide-react'
import { StatusBadge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { useLeadDrawer } from '@/lib/lead-drawer-context'
import { formatDate } from '@/lib/utils'
import { AddLeadModal } from '@/components/leads/AddLeadModal'
import { ImportLeadsModal } from '@/components/leads/ImportLeadsModal'

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
  halal_confidence_score: number | null
  halal_reasons: string[] | null
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
  source: string | null
}

type BulkAction = 'send' | 'delete' | 'research'

interface BulkResult {
  sent?: number
  deleted?: number
  researched?: number
  failed: Array<{ lead_id: string; business_name?: string; reason: string }>
}

interface RegenerateFailure {
  lead_id: string
  business_name: string
  reason: string
}

interface RegenerateResult {
  succeeded: number
  failed: RegenerateFailure[]
}

const STATUS_OPTIONS = ['new', 'researched', 'email_ready', 'contacted', 'replied', 'negotiating', 'interested', 'closed', 'closed_won', 'closed_manual', 'dead']

interface LeadsTableProps {
  initialStatus?: string
  initialStage?: string
}

function HalalConfidenceBadge({ score }: { score: number | null }) {
  if (score == null) return <span style={{ color: '#64748b' }}>—</span>
  const label = `${score}%`
  if (score >= 80) {
    return (
      <span
        className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium"
        style={{ background: 'rgba(74,222,128,0.12)', color: '#4ade80', border: '1px solid rgba(74,222,128,0.2)' }}
      >
        {label}
      </span>
    )
  }
  if (score >= 40) {
    return (
      <span
        className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium"
        style={{ background: 'rgba(251,191,36,0.12)', color: '#fbbf24', border: '1px solid rgba(251,191,36,0.2)' }}
      >
        {label}
      </span>
    )
  }
  return (
    <span
      className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium"
      style={{ background: 'rgba(248,113,113,0.12)', color: '#f87171', border: '1px solid rgba(248,113,113,0.2)' }}
    >
      {label}
    </span>
  )
}

// ── Bulk confirmation / result modal ──────────────────────────────────────────

interface BulkModalProps {
  action: BulkAction
  count: number
  running: boolean
  result: BulkResult | null
  onConfirm: () => void
  onClose: () => void
}

function BulkModal({ action, count, running, result, onConfirm, onClose }: BulkModalProps) {
  const successCount = result?.sent ?? result?.deleted ?? result?.researched ?? 0
  const failedCount  = result?.failed.length ?? 0

  const confirmLabel: Record<BulkAction, string> = {
    send:       'Send Initial Emails',
    delete:     'Delete Leads',
    research:   'Research Selected',
  }
  const confirmMessage: Record<BulkAction, string> = {
    send:       `Send initial outreach emails to ${count} selected lead${count === 1 ? '' : 's'}?`,
    delete:     `Permanently delete ${count} lead${count === 1 ? '' : 's'} and all associated data? This cannot be undone.`,
    research:   `Run research on ${count} selected new lead${count === 1 ? '' : 's'}? This will find contact info and generate draft emails.`,
  }
  const runningLabel: Record<BulkAction, string> = {
    send:       'Sending…',
    delete:     'Deleting…',
    research:   'Researching…',
  }
  const successVerb: Record<BulkAction, string> = {
    send:       'sent',
    delete:     'deleted',
    research:   'researched',
  }
  const successUnit: Record<BulkAction, string> = {
    send:       'email',
    delete:     'lead',
    research:   'lead',
  }
  const successNote: Partial<Record<BulkAction, string>> = {
    research: 'Leads with emails will now appear in Email Ready.',
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(2px)' }}
    >
      <div
        className="w-full max-w-md mx-4 rounded-2xl p-6"
        style={{ background: '#0d0f18', border: '1px solid rgba(255,255,255,0.08)', boxShadow: '0 24px 80px rgba(0,0,0,0.6)' }}
      >
        {result ? (
          // ── Result view ──
          <>
            <div className="flex items-start justify-between mb-4">
              <h3 className="text-base font-semibold" style={{ color: '#f1f5f9' }}>
                {confirmLabel[action]} — Complete
              </h3>
              <button onClick={onClose} style={{ color: '#475569' }}><X size={16} /></button>
            </div>

            {successCount > 0 && (
              <>
                <p className="text-sm mb-2" style={{ color: '#4ade80' }}>
                  Successfully {successVerb[action]} {successCount} {successUnit[action]}{successCount === 1 ? '' : 's'}.
                </p>
                {successNote[action] && (
                  <p className="text-xs mb-2" style={{ color: '#94a3b8' }}>{successNote[action]}</p>
                )}
              </>
            )}

            {failedCount > 0 && (
              <div className="mt-2">
                <p className="text-sm mb-2" style={{ color: '#f87171' }}>
                  {failedCount} failed:
                </p>
                <ul className="space-y-1 max-h-48 overflow-y-auto">
                  {result.failed.map((f, i) => (
                    <li key={i} className="text-xs px-2 py-1 rounded" style={{ background: 'rgba(248,113,113,0.08)', color: '#fca5a5' }}>
                      <span className="font-medium">{f.business_name ?? f.lead_id}</span>
                      {' — '}{f.reason}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {successCount === 0 && failedCount === 0 && (
              <p className="text-sm" style={{ color: '#64748b' }}>No leads were processed.</p>
            )}

            <div className="flex justify-end mt-5">
              <Button onClick={onClose}>Done</Button>
            </div>
          </>
        ) : (
          // ── Confirmation view ──
          <>
            <div className="flex items-start justify-between mb-3">
              <h3 className="text-base font-semibold" style={{ color: '#f1f5f9' }}>{confirmLabel[action]}</h3>
              <button onClick={onClose} disabled={running} style={{ color: '#475569' }}><X size={16} /></button>
            </div>
            <p className="text-sm mb-6" style={{ color: '#94a3b8' }}>{confirmMessage[action]}</p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={onClose} disabled={running}>Cancel</Button>
              <Button
                onClick={onConfirm}
                disabled={running}
                style={action === 'delete' ? { background: 'rgba(248,113,113,0.15)', color: '#f87171', border: '1px solid rgba(248,113,113,0.25)' } : undefined}
              >
                {running ? runningLabel[action] : confirmLabel[action]}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ── Regenerate Initial Emails modal ───────────────────────────────────────────
// Bespoke flow (not the generic BulkModal): calls the existing single-lead
// regenerate-email endpoint once per lead so we get real per-lead progress,
// and reuses that endpoint's UPDATE-only behavior — subject/body only, every
// other field (status, follow-ups, notes, tags, enrichment) stays untouched.

interface RegenerateEmailsModalProps {
  open: boolean
  selectedCount: number
  filteredCount: number | null
  filteredLoading: boolean
  scope: 'selected' | 'filtered'
  onScopeChange: (scope: 'selected' | 'filtered') => void
  running: boolean
  progress: { done: number; total: number }
  result: RegenerateResult | null
  onConfirm: () => void
  onClose: () => void
}

function RegenerateEmailsModal({
  open, selectedCount, filteredCount, filteredLoading, scope, onScopeChange,
  running, progress, result, onConfirm, onClose,
}: RegenerateEmailsModalProps) {
  if (!open) return null

  const targetCount = scope === 'filtered' ? (filteredCount ?? 0) : selectedCount
  const pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(2px)' }}
    >
      <div
        className="w-full max-w-md mx-4 rounded-2xl p-6"
        style={{ background: '#0d0f18', border: '1px solid rgba(255,255,255,0.08)', boxShadow: '0 24px 80px rgba(0,0,0,0.6)' }}
      >
        {result ? (
          // ── Result view ──
          <>
            <div className="flex items-start justify-between mb-4">
              <h3 className="text-base font-semibold" style={{ color: '#f1f5f9' }}>Regenerate Initial Emails — Complete</h3>
              <button onClick={onClose} style={{ color: '#475569' }}><X size={16} /></button>
            </div>

            {result.succeeded > 0 && (
              <p className="text-sm mb-2" style={{ color: '#4ade80' }}>
                Successfully regenerated {result.succeeded} email{result.succeeded === 1 ? '' : 's'}. Status, follow-ups, notes, tags and enrichment were left unchanged.
              </p>
            )}

            {result.failed.length > 0 && (
              <div className="mt-2">
                <p className="text-sm mb-2" style={{ color: '#f87171' }}>{result.failed.length} failed:</p>
                <ul className="space-y-1 max-h-48 overflow-y-auto">
                  {result.failed.map((f, i) => (
                    <li key={i} className="text-xs px-2 py-1 rounded" style={{ background: 'rgba(248,113,113,0.08)', color: '#fca5a5' }}>
                      <span className="font-medium">{f.business_name}</span>
                      {' — '}{f.reason}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {result.succeeded === 0 && result.failed.length === 0 && (
              <p className="text-sm" style={{ color: '#64748b' }}>No leads were processed.</p>
            )}

            <div className="flex justify-end mt-5">
              <Button onClick={onClose}>Done</Button>
            </div>
          </>
        ) : running ? (
          // ── Progress view ──
          <>
            <div className="mb-4">
              <h3 className="text-base font-semibold" style={{ color: '#f1f5f9' }}>Regenerating Initial Emails…</h3>
            </div>
            <p className="text-sm mb-3" style={{ color: '#94a3b8' }}>
              {progress.done} / {progress.total} regenerated
            </p>
            <div className="w-full h-2 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.06)' }}>
              <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: '#38bdf8' }} />
            </div>
          </>
        ) : (
          // ── Confirmation view ──
          <>
            <div className="flex items-start justify-between mb-3">
              <h3 className="text-base font-semibold" style={{ color: '#f1f5f9' }}>Regenerate Initial Emails</h3>
              <button onClick={onClose} style={{ color: '#475569' }}><X size={16} /></button>
            </div>

            <div className="space-y-2 mb-4">
              <label className="flex items-start gap-2 text-sm cursor-pointer" style={{ color: '#e2e8f0' }}>
                <input
                  type="radio"
                  checked={scope === 'selected'}
                  onChange={() => onScopeChange('selected')}
                  className="mt-0.5"
                  style={{ accentColor: '#38bdf8' }}
                />
                <span>{selectedCount} selected lead{selectedCount === 1 ? '' : 's'}</span>
              </label>
              {filteredCount !== null && (
                <label className="flex items-start gap-2 text-sm cursor-pointer" style={{ color: '#e2e8f0' }}>
                  <input
                    type="radio"
                    checked={scope === 'filtered'}
                    onChange={() => onScopeChange('filtered')}
                    className="mt-0.5"
                    style={{ accentColor: '#38bdf8' }}
                  />
                  <span>All {filteredCount} lead{filteredCount === 1 ? '' : 's'} matching the current filters</span>
                </label>
              )}
              {filteredLoading && (
                <p className="text-xs" style={{ color: '#64748b' }}>Checking how many leads match the current filters…</p>
              )}
            </div>

            <p className="text-sm mb-6" style={{ color: '#94a3b8' }}>
              Regenerates the subject and body of the initial outreach email for {targetCount} lead{targetCount === 1 ? '' : 's'} using the latest email prompt. Status, follow-ups, notes, tags and enrichment data are left untouched.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={onClose}>Cancel</Button>
              <Button onClick={onConfirm} disabled={targetCount === 0}>
                Regenerate Initial Emails
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ── Main table ────────────────────────────────────────────────────────────────

export function LeadsTable({ initialStatus, initialStage }: LeadsTableProps) {
  const { openDrawer, refreshKey } = useLeadDrawer()

  const [leads, setLeads] = useState<Lead[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [addModalOpen, setAddModalOpen] = useState(false)
  const [importModalOpen, setImportModalOpen] = useState(false)

  const [search, setSearch] = useState('')
  const [status, setStatus] = useState(initialStatus ?? '')
  const [city, setCity] = useState('')
  const [cities, setCities] = useState<string[]>([])

  useEffect(() => {
    fetch('/api/cities')
      .then((r) => r.json() as Promise<{ data?: string[] }>)
      .then((json) => setCities(json.data ?? []))
      .catch(() => {})
  }, [])

  // Bulk selection state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [bulkAction, setBulkAction] = useState<BulkAction | null>(null)
  const [bulkRunning, setBulkRunning] = useState(false)
  const [bulkResult, setBulkResult] = useState<BulkResult | null>(null)
  const selectAllRef = useRef<HTMLInputElement>(null)

  // Regenerate Initial Emails state
  const [regenerateOpen, setRegenerateOpen] = useState(false)
  const [regenerateScope, setRegenerateScope] = useState<'selected' | 'filtered'>('selected')
  const [filteredEligible, setFilteredEligible] = useState<{ id: string; business_name: string }[] | null>(null)
  const [filteredEligibleLoading, setFilteredEligibleLoading] = useState(false)
  const [regenerateRunning, setRegenerateRunning] = useState(false)
  const [regenerateProgress, setRegenerateProgress] = useState({ done: 0, total: 0 })
  const [regenerateResult, setRegenerateResult] = useState<RegenerateResult | null>(null)

  const fetchLeads = useCallback(async () => {
    setLoading(true)
    const params = new URLSearchParams({ page: String(page) })
    if (search) params.set('search', search)
    if (initialStage && !status) {
      params.set('stage', initialStage)
    } else if (status) {
      params.set('status', status)
    }
    if (city) params.set('city', city)

    const res = await fetch(`/api/leads?${params}`)
    const json = await res.json() as { data: Lead[]; count: number }
    setLeads(json.data ?? [])
    setTotal(json.count ?? 0)
    setLoading(false)
  }, [page, search, status, city, initialStage])

  useEffect(() => { fetchLeads() }, [fetchLeads])
  useEffect(() => { if (refreshKey > 0) fetchLeads() }, [refreshKey, fetchLeads])

  // Clear selection when page changes
  useEffect(() => { setSelectedIds(new Set()) }, [page])

  // email_ready non-manual leads → send/regenerate/delete actions
  const emailReadyEligibleLeads = leads.filter(l => l.status === 'email_ready' && l.source !== 'manual')
  // new leads → research action
  const researchEligibleLeads = leads.filter(l => l.status === 'new')
  // combined for header checkbox and select-all
  const bulkEligibleLeads = [...emailReadyEligibleLeads, ...researchEligibleLeads]

  const selectedEmailReadyLeads = emailReadyEligibleLeads.filter(l => selectedIds.has(l.id))
  const selectedNewLeads = researchEligibleLeads.filter(l => selectedIds.has(l.id))

  const allEligibleSelected = bulkEligibleLeads.length > 0 && bulkEligibleLeads.every(l => selectedIds.has(l.id))
  const someEligibleSelected = bulkEligibleLeads.some(l => selectedIds.has(l.id))

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = someEligibleSelected && !allEligibleSelected
    }
  }, [someEligibleSelected, allEligibleSelected])

  function toggleSelect(id: string, e: React.ChangeEvent<HTMLInputElement> | React.MouseEvent) {
    e.stopPropagation()
    setSelectedIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  function handleSelectAll() {
    if (allEligibleSelected) {
      setSelectedIds(prev => {
        const next = new Set(prev)
        bulkEligibleLeads.forEach(l => next.delete(l.id))
        return next
      })
    } else {
      setSelectedIds(prev => {
        const next = new Set(prev)
        bulkEligibleLeads.forEach(l => next.add(l.id))
        return next
      })
    }
  }

  async function runBulkAction() {
    if (!bulkAction || bulkRunning) return
    setBulkRunning(true)
    const actionMap: Record<BulkAction, string> = {
      send:       'send_initial_emails',
      delete:     'delete',
      research:   'research_leads',
    }
    // Research only operates on new leads; other actions use the full selection
    const leadIds = bulkAction === 'research'
      ? selectedNewLeads.map(l => l.id)
      : Array.from(selectedIds)
    try {
      const res = await fetch('/api/leads/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: actionMap[bulkAction], lead_ids: leadIds }),
      })
      const json = await res.json() as BulkResult
      setBulkResult(json)
      fetchLeads()
    } catch {
      setBulkResult({ failed: [{ lead_id: '', reason: 'Network error — please try again' }] })
    } finally {
      setBulkRunning(false)
    }
  }

  function closeBulkModal() {
    setBulkAction(null)
    setBulkResult(null)
    if (bulkResult !== null) {
      setSelectedIds(new Set())
    }
  }

  function openRegenerateDialog() {
    setRegenerateScope('selected')
    setFilteredEligible(null)
    setRegenerateResult(null)
    setRegenerateOpen(true)

    // "All filtered" is only unambiguous when the page is scoped to email_ready —
    // fetch the true eligible count/ids across every page (not just this one).
    if (status === 'email_ready') {
      setFilteredEligibleLoading(true)
      const params = new URLSearchParams({ status: 'email_ready', ids_only: 'true' })
      if (search) params.set('search', search)
      if (city) params.set('city', city)

      fetch(`/api/leads?${params}`)
        .then((r) => r.json())
        .then((json: { data?: Array<{ id: string; business_name: string; source: string | null }> }) => {
          const eligible = (json.data ?? []).filter((l) => l.source !== 'manual')
          setFilteredEligible(eligible.map((l) => ({ id: l.id, business_name: l.business_name })))
        })
        .catch(() => setFilteredEligible([]))
        .finally(() => setFilteredEligibleLoading(false))
    }
  }

  function closeRegenerateDialog() {
    if (regenerateRunning) return
    setRegenerateOpen(false)
    if (regenerateResult !== null) {
      setSelectedIds(new Set())
    }
  }

  async function runRegenerate() {
    if (regenerateRunning) return

    const targets = regenerateScope === 'filtered' && filteredEligible
      ? filteredEligible
      : selectedEmailReadyLeads.map((l) => ({ id: l.id, business_name: l.business_name }))

    if (targets.length === 0) return

    setRegenerateRunning(true)
    setRegenerateProgress({ done: 0, total: targets.length })
    const failed: RegenerateFailure[] = []
    let succeeded = 0

    for (const lead of targets) {
      try {
        const res = await fetch(`/api/leads/${lead.id}/regenerate-email`, { method: 'POST' })
        if (!res.ok) {
          const json = await res.json().catch(() => ({} as { error?: string }))
          failed.push({ lead_id: lead.id, business_name: lead.business_name, reason: json.error ?? `Request failed (${res.status})` })
        } else {
          succeeded++
        }
      } catch {
        failed.push({ lead_id: lead.id, business_name: lead.business_name, reason: 'Network error — please try again' })
      }
      setRegenerateProgress((p) => ({ ...p, done: p.done + 1 }))
    }

    setRegenerateResult({ succeeded, failed })
    setRegenerateRunning(false)
    fetchLeads()
  }

  const totalPages = Math.ceil(total / 50)

  return (
    <div className="relative">
      {/* Filters */}
      <div className="flex flex-col sm:flex-row flex-wrap gap-2 p-3 md:p-4 border-b" style={{ borderColor: '#2a2d3e' }}>
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
            {cities.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>

          {(search || status || city) && (
            <Button variant="ghost" size="sm" onClick={() => { setSearch(''); setStatus(''); setCity(''); setPage(1) }}>
              Clear
            </Button>
          )}

          <span className="text-sm ml-auto sm:ml-0" style={{ color: '#64748b' }}>{total} leads</span>

          <Button size="sm" variant="ghost" onClick={() => setImportModalOpen(true)}>
            <Upload size={13} />
            Import Leads
          </Button>

          <Button size="sm" onClick={() => setAddModalOpen(true)}>
            <Plus size={13} />
            Add Lead
          </Button>
        </div>
      </div>

      <AddLeadModal
        open={addModalOpen}
        onClose={() => setAddModalOpen(false)}
        onCreated={fetchLeads}
      />

      <ImportLeadsModal
        open={importModalOpen}
        onClose={() => setImportModalOpen(false)}
        onImported={fetchLeads}
      />

      {/* Bulk selection bar */}
      {selectedIds.size > 0 && (
        <div
          className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 border-b"
          style={{ background: 'rgba(56,189,248,0.04)', borderColor: '#2a2d3e' }}
        >
          <span className="text-xs font-semibold" style={{ color: '#38bdf8' }}>
            {selectedIds.size} selected
          </span>

          <div className="h-3.5 w-px hidden sm:block" style={{ background: '#2a2d3e' }} />

          {bulkEligibleLeads.length > 0 && !allEligibleSelected && (
            <button
              onClick={handleSelectAll}
              className="text-xs transition-colors hover:opacity-80"
              style={{ color: '#64748b' }}
            >
              Select all eligible ({bulkEligibleLeads.length})
            </button>
          )}

          <button
            onClick={() => setSelectedIds(new Set())}
            className="text-xs transition-colors hover:opacity-80"
            style={{ color: '#64748b' }}
          >
            Clear
          </button>

          <div className="ml-auto flex flex-wrap gap-2">
            {selectedNewLeads.length > 0 && (
              <Button
                size="sm"
                onClick={() => { setBulkResult(null); setBulkAction('research') }}
              >
                <Microscope size={12} />
                Research Selected ({selectedNewLeads.length})
              </Button>
            )}
            {selectedEmailReadyLeads.length > 0 && (
              <>
                <Button
                  size="sm"
                  onClick={() => { setBulkResult(null); setBulkAction('send') }}
                >
                  <Send size={12} />
                  Send Initial Emails
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={openRegenerateDialog}
                >
                  <RefreshCw size={12} />
                  Regenerate Initial Emails
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => { setBulkResult(null); setBulkAction('delete') }}
                  style={{ color: '#f87171' }}
                >
                  <Trash2 size={12} />
                  Delete
                </Button>
              </>
            )}
          </div>
        </div>
      )}

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr style={{ borderBottom: '1px solid #2a2d3e' }}>
              {/* Checkbox header — only shown when non-manual email_ready leads exist */}
              <th className="w-10 px-3 py-3">
                {bulkEligibleLeads.length > 0 && (
                  <input
                    ref={selectAllRef}
                    type="checkbox"
                    checked={allEligibleSelected}
                    onChange={handleSelectAll}
                    onClick={(e) => e.stopPropagation()}
                    title="Select all eligible leads"
                    className="w-3.5 h-3.5 rounded cursor-pointer"
                    style={{ accentColor: '#38bdf8' }}
                  />
                )}
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider" style={{ color: '#64748b' }}>Business</th>
              <th className="hidden md:table-cell px-4 py-3 text-left text-xs font-medium uppercase tracking-wider" style={{ color: '#64748b' }}>Category</th>
              <th className="hidden md:table-cell px-4 py-3 text-left text-xs font-medium uppercase tracking-wider" style={{ color: '#64748b' }}>Location</th>
              <th className="hidden md:table-cell px-4 py-3 text-left text-xs font-medium uppercase tracking-wider" style={{ color: '#64748b' }}>Contact</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider" style={{ color: '#64748b' }}>Status</th>
              <th className="hidden md:table-cell px-4 py-3 text-left text-xs font-medium uppercase tracking-wider" style={{ color: '#64748b' }}>Rating</th>
              <th className="hidden md:table-cell px-4 py-3 text-left text-xs font-medium uppercase tracking-wider" style={{ color: '#64748b' }}>Halal</th>
              <th className="hidden md:table-cell px-4 py-3 text-left text-xs font-medium uppercase tracking-wider" style={{ color: '#64748b' }}>Added</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider" style={{ color: '#64748b' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={10} className="px-4 py-12 text-center" style={{ color: '#64748b' }}>Loading...</td>
              </tr>
            ) : leads.length === 0 ? (
              <tr>
                <td colSpan={10} className="px-4 py-12 text-center" style={{ color: '#64748b' }}>No leads found</td>
              </tr>
            ) : (
              leads.map((lead) => {
                const isSelected    = selectedIds.has(lead.id)
                const isEmailReady  = lead.status === 'email_ready'
                const isNew         = lead.status === 'new'
                const isManual      = lead.source === 'manual'
                const isBulkEligible = (isEmailReady && !isManual) || isNew
                return (
                  <tr
                    key={lead.id}
                    className="border-b cursor-pointer transition-colors hover:bg-white/2"
                    style={{
                      borderColor: '#1e2130',
                      background: isSelected ? 'rgba(56,189,248,0.04)' : undefined,
                    }}
                    onClick={() => openDrawer(lead.id)}
                  >
                    {/* Checkbox cell */}
                    <td className="w-10 px-3 py-3" onClick={(e) => e.stopPropagation()}>
                      {isBulkEligible && (
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={(e) => toggleSelect(lead.id, e)}
                          className="w-3.5 h-3.5 rounded cursor-pointer"
                          style={{ accentColor: '#38bdf8' }}
                        />
                      )}
                      {isEmailReady && isManual && (
                        <input
                          type="checkbox"
                          disabled
                          title="Manual lead — use the individual Send button in the lead drawer"
                          className="w-3.5 h-3.5 rounded cursor-not-allowed opacity-25"
                        />
                      )}
                    </td>
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
                    <td className="hidden md:table-cell px-4 py-3">
                      <HalalConfidenceBadge score={lead.halal_confidence_score} />
                    </td>
                    <td className="hidden md:table-cell px-4 py-3 text-xs" style={{ color: '#64748b' }}>{formatDate(lead.created_at)}</td>
                    <td className="px-4 py-3">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={(e) => { e.stopPropagation(); openDrawer(lead.id) }}
                      >
                        View
                      </Button>
                    </td>
                  </tr>
                )
              })
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

      {/* Bulk action modal */}
      {bulkAction && (
        <BulkModal
          action={bulkAction}
          count={selectedIds.size}
          running={bulkRunning}
          result={bulkResult}
          onConfirm={runBulkAction}
          onClose={closeBulkModal}
        />
      )}

      {/* Regenerate Initial Emails modal */}
      <RegenerateEmailsModal
        open={regenerateOpen}
        selectedCount={selectedEmailReadyLeads.length}
        filteredCount={filteredEligible?.length ?? null}
        filteredLoading={filteredEligibleLoading}
        scope={regenerateScope}
        onScopeChange={setRegenerateScope}
        running={regenerateRunning}
        progress={regenerateProgress}
        result={regenerateResult}
        onConfirm={runRegenerate}
        onClose={closeRegenerateDialog}
      />
    </div>
  )
}
