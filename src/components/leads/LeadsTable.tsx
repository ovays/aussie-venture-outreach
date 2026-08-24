'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { Search, Star, AtSign, Mail, Plus, Send, RefreshCw, Trash2, X, Microscope, Upload } from 'lucide-react'
import { StatusBadge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { useLeadDrawer } from '@/lib/lead-drawer-context'
import { formatDate } from '@/lib/utils'
import { AddLeadModal } from '@/components/leads/AddLeadModal'
import { ImportLeadsModal } from '@/components/leads/ImportLeadsModal'
import {
  createLeadsFilterSearchParams,
  createLeadsFilterSnapshot,
  createUniqueIdBatches,
  FILTERED_IDS_PAGE_SIZE,
  LEADS_PAGE_SIZE,
  normalizeLeadsSearch,
} from '@/lib/leads-list'
import {
  createLeadsBulkProgress,
  runSequentialLeadsBulkOperation,
  summarizeLeadsBulkOutcomes,
  type LeadsBulkOperationResponse,
  type LeadsBulkOutcome,
  type LeadsBulkProgress,
} from '@/lib/leads-bulk-progress'
import { captureInitialEmailModeSnapshot } from '@/lib/initial-email-mode-operation'

interface Lead {
  id: string
  business_name: string
  category_name: string
  city: string
  suburb: string | null
  email: string | null
  instagram_handle: string | null
  google_rating: number | null
  halal_confidence_score: number | null
  status: string
  created_at: string
  halal: boolean
}

type BulkAction = 'send' | 'delete' | 'research' | 'process'

interface BulkResult {
  progress: LeadsBulkProgress
  outcomes: LeadsBulkOutcome[]
}

interface RegenerateResult {
  progress: LeadsBulkProgress
  mode: 'ai_personalised' | 'template'
  outcomes: LeadsBulkOutcome[]
}

const STATUS_OPTIONS = ['new', 'researched', 'email_ready', 'contacted', 'replied', 'negotiating', 'interested', 'closed', 'closed_won', 'closed_manual', 'dead']
const SEARCH_DEBOUNCE_MS = 300

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

function ProgressStatus({
  progress,
  actionLabel,
  successLabel,
}: {
  progress: LeadsBulkProgress
  actionLabel: string
  successLabel: string
}) {
  const pct = progress.total > 0 ? Math.round((progress.processed / progress.total) * 100) : 0

  return (
    <div role="status" aria-live="polite">
      <h3 className="text-base font-semibold mb-4" style={{ color: '#f1f5f9' }}>{actionLabel}</h3>
      <p className="text-sm mb-2" style={{ color: '#94a3b8' }}>
        {progress.processed} / {progress.total} processed
      </p>
      <div
        className="w-full h-2 rounded-full overflow-hidden"
        style={{ background: 'rgba(255,255,255,0.06)' }}
        role="progressbar"
        aria-label={`${actionLabel}: ${progress.processed} of ${progress.total} processed`}
        aria-valuemin={0}
        aria-valuemax={progress.total}
        aria-valuenow={progress.processed}
      >
        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: '#38bdf8' }} />
      </div>
      <p className="text-xs mt-3" style={{ color: '#64748b' }}>
        {progress.succeeded} {successLabel} · {progress.skipped} skipped · {progress.failed} failed
      </p>
    </div>
  )
}

function OutcomeDetails({ outcomes }: { outcomes: LeadsBulkOutcome[] }) {
  const nonSuccess = outcomes.filter((outcome) => outcome.status !== 'succeeded')
  if (nonSuccess.length === 0) return null

  return (
    <ul className="space-y-1 max-h-48 overflow-y-auto mt-3">
      {nonSuccess.map((outcome, index) => (
        <li
          key={`${outcome.lead_id}-${index}`}
          className="text-xs px-2 py-1 rounded"
          style={{
            background: outcome.status === 'failed' ? 'rgba(248,113,113,0.08)' : 'rgba(251,191,36,0.08)',
            color: outcome.status === 'failed' ? '#fca5a5' : '#fcd34d',
          }}
        >
          <span className="font-medium">{(outcome.business_name ?? outcome.lead_id) || 'Request'}</span>
          {` — ${outcome.status === 'failed' ? 'Failed' : 'Skipped'}${outcome.reason ? `: ${outcome.reason}` : ''}`}
        </li>
      ))}
    </ul>
  )
}

interface BulkModalProps {
  action: BulkAction
  count: number
  running: boolean
  progress: LeadsBulkProgress
  result: BulkResult | null
  onConfirm: () => void
  onClose: () => void
}

function BulkModal({ action, count, running, progress, result, onConfirm, onClose }: BulkModalProps) {
  const successCount = result?.progress.succeeded ?? 0
  const skippedCount = result?.progress.skipped ?? 0
  const failedCount = result?.progress.failed ?? 0

  const confirmLabel: Record<BulkAction, string> = {
    send:       'Send Initial Emails',
    delete:     'Delete Leads',
    research:   'Research Selected',
    process:    'Process to Email Ready',
  }
  const confirmMessage: Record<BulkAction, string> = {
    send:       `Send initial outreach emails to ${count} selected lead${count === 1 ? '' : 's'}?`,
    delete:     `Permanently delete ${count} lead${count === 1 ? '' : 's'} and all associated data? This cannot be undone.`,
    research:   `Run research on ${count} selected new lead${count === 1 ? '' : 's'}? This will find contact info and generate draft emails.`,
    process:    `Generate a pending Initial Email for ${count} selected researched lead${count === 1 ? '' : 's'} and move successful leads to Email Ready?`,
  }
  const runningLabel: Record<BulkAction, string> = {
    send:       'Sending…',
    delete:     'Deleting…',
    research:   'Researching…',
    process:    'Processing…',
  }
  const successVerb: Record<BulkAction, string> = {
    send:       'sent',
    delete:     'deleted',
    research:   'researched',
    process:    'processed',
  }
  const successUnit: Record<BulkAction, string> = {
    send:       'email',
    delete:     'lead',
    research:   'lead',
    process:    'lead',
  }
  const successNote: Partial<Record<BulkAction, string>> = {
    research: 'Leads with emails will now appear in Email Ready.',
    process: 'Successful leads now appear in Email Ready with a pending Initial Email.',
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

            <p className="text-sm mb-3" style={{ color: '#94a3b8' }}>
              {result.progress.processed} / {result.progress.total} processed
            </p>

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

            <p className="text-sm" style={{ color: '#94a3b8' }}>
              {successCount} {successVerb[action]} · {skippedCount} skipped · {failedCount} failed
            </p>
            <OutcomeDetails outcomes={result.outcomes} />

            {result.progress.processed === 0 && (
              <p className="text-sm" style={{ color: '#64748b' }}>No leads were processed.</p>
            )}

            <div className="flex justify-end mt-5">
              <Button onClick={onClose}>Done</Button>
            </div>
          </>
        ) : running ? (
          <ProgressStatus
            progress={progress}
            actionLabel={runningLabel[action]}
            successLabel={successVerb[action]}
          />
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
// Bespoke scope picker with the shared sequential progress runner. Each request
// contains one lead so the server can confirm a real per-lead outcome, while
// the regeneration route keeps its UPDATE-only behavior — subject/body only, every
// other field (status, follow-ups, notes, tags, enrichment) stays untouched.

interface RegenerateEmailsModalProps {
  open: boolean
  selectedCount: number
  filteredCount: number | null
  filteredLoading: boolean
  scope: 'selected' | 'filtered'
  onScopeChange: (scope: 'selected' | 'filtered') => void
  running: boolean
  progress: LeadsBulkProgress
  result: RegenerateResult | null
  mode: 'ai_personalised' | 'template' | null
  onConfirm: () => void
  onClose: () => void
}

function RegenerateEmailsModal({
  open, selectedCount, filteredCount, filteredLoading, scope, onScopeChange,
  running, progress, result, mode, onConfirm, onClose,
}: RegenerateEmailsModalProps) {
  if (!open) return null

  const targetCount = scope === 'filtered' ? (filteredCount ?? 0) : selectedCount
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

            <p className="text-sm mb-3" style={{ color: '#94a3b8' }}>
              {result.progress.processed} / {result.progress.total} processed
            </p>

            {result.progress.succeeded > 0 && (
              <p className="text-sm mb-2" style={{ color: '#4ade80' }}>
                Successfully regenerated {result.progress.succeeded} email{result.progress.succeeded === 1 ? '' : 's'}. Status, follow-ups, notes, tags and enrichment were left unchanged.
              </p>
            )}

            <p className="text-sm" style={{ color: '#94a3b8' }}>
              {result.progress.succeeded} regenerated · {result.progress.skipped} skipped · {result.progress.failed} failed
            </p>
            <OutcomeDetails outcomes={result.outcomes} />

            {result.progress.processed === 0 && (
              <p className="text-sm" style={{ color: '#64748b' }}>No leads were processed.</p>
            )}

            <div className="flex justify-end mt-5">
              <Button onClick={onClose}>Done</Button>
            </div>
          </>
        ) : running ? (
          <ProgressStatus progress={progress} actionLabel="Regenerating Initial Emails…" successLabel="regenerated" />
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
              Regenerate {targetCount} initial email{targetCount === 1 ? '' : 's'} using {mode === 'template' ? 'Template' : mode === 'ai_personalised' ? 'AI Personalised' : 'the saved'} mode? Existing unsent Initial Emails will be replaced. Sent emails and follow-ups are left untouched.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={onClose}>Cancel</Button>
              <Button onClick={onConfirm} disabled={targetCount === 0 || mode === null}>
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
  const [loadError, setLoadError] = useState<string | null>(null)
  const [addModalOpen, setAddModalOpen] = useState(false)
  const [importModalOpen, setImportModalOpen] = useState(false)

  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
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
  const [bulkProgress, setBulkProgress] = useState<LeadsBulkProgress>(() => createLeadsBulkProgress(0))
  const [bulkResult, setBulkResult] = useState<BulkResult | null>(null)
  const selectAllRef = useRef<HTMLInputElement>(null)

  // Regenerate Initial Emails state
  const [regenerateOpen, setRegenerateOpen] = useState(false)
  const [regenerateScope, setRegenerateScope] = useState<'selected' | 'filtered'>('selected')
  const [filteredEligible, setFilteredEligible] = useState<{ id: string }[] | null>(null)
  const [filteredEligibleLoading, setFilteredEligibleLoading] = useState(false)
  const [regenerateRunning, setRegenerateRunning] = useState(false)
  const [regenerateProgress, setRegenerateProgress] = useState<LeadsBulkProgress>(() => createLeadsBulkProgress(0))
  const [regenerateResult, setRegenerateResult] = useState<RegenerateResult | null>(null)
  const [regenerateMode, setRegenerateMode] = useState<'ai_personalised' | 'template' | null>(null)
  const leadsRequestRef = useRef<AbortController | null>(null)
  const leadsRequestSequenceRef = useRef(0)
  const filteredIdsRequestRef = useRef<AbortController | null>(null)
  const filteredIdsRequestSequenceRef = useRef(0)
  const operationActiveRef = useRef(false)
  const filterControlsKey = JSON.stringify([normalizeLeadsSearch(search), status, city, initialStage ?? ''])
  const previousFilterControlsKeyRef = useRef(filterControlsKey)

  useEffect(() => {
    if (search === '') {
      setDebouncedSearch('')
      return
    }

    const timeout = window.setTimeout(
      () => setDebouncedSearch(normalizeLeadsSearch(search)),
      SEARCH_DEBOUNCE_MS,
    )
    return () => window.clearTimeout(timeout)
  }, [search])

  const fetchLeads = useCallback(async () => {
    const requestSequence = ++leadsRequestSequenceRef.current
    leadsRequestRef.current?.abort()
    const controller = new AbortController()
    leadsRequestRef.current = controller
    setLoading(true)
    setLoadError(null)
    const filterSnapshot = createLeadsFilterSnapshot({
      rawSearch: debouncedSearch,
      status,
      stage: initialStage,
      city,
    })
    const params = createLeadsFilterSearchParams(filterSnapshot)
    params.set('page', String(page))

    try {
      const res = await fetch(`/api/leads?${params}`, { signal: controller.signal })
      const json = await res.json() as { data?: Lead[]; count?: number }
      if (!res.ok) throw new Error('Failed to load leads')
      if (requestSequence !== leadsRequestSequenceRef.current) return

      const nextTotal = json.count ?? 0
      const lastValidPage = Math.max(1, Math.ceil(nextTotal / LEADS_PAGE_SIZE))
      if (page > lastValidPage) {
        setPage(lastValidPage)
        return
      }

      setLeads(json.data ?? [])
      setTotal(nextTotal)
      setLoadError(null)
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      if (requestSequence !== leadsRequestSequenceRef.current) return
      setLeads([])
      setTotal(0)
      setSelectedIds(new Set())
      setLoadError('Unable to load leads. Please try again.')
    } finally {
      if (requestSequence === leadsRequestSequenceRef.current) setLoading(false)
    }
  }, [page, debouncedSearch, status, city, initialStage])

  useEffect(() => {
    void fetchLeads()
    return () => leadsRequestRef.current?.abort()
  }, [fetchLeads, refreshKey])

  useEffect(() => {
    const filtersChanged = previousFilterControlsKeyRef.current !== filterControlsKey
    previousFilterControlsKeyRef.current = filterControlsKey
    if (!filtersChanged || !regenerateOpen) return

    filteredIdsRequestSequenceRef.current += 1
    filteredIdsRequestRef.current?.abort()
    setFilteredEligible(null)
    setFilteredEligibleLoading(false)
  }, [filterControlsKey, regenerateOpen])

  useEffect(() => () => {
    filteredIdsRequestSequenceRef.current += 1
    filteredIdsRequestRef.current?.abort()
  }, [])

  function invalidateFilteredIdsLookup() {
    filteredIdsRequestSequenceRef.current += 1
    filteredIdsRequestRef.current?.abort()
    if (regenerateOpen) {
      setFilteredEligible(null)
      setFilteredEligibleLoading(false)
    }
  }

  // Clear selection when page changes
  useEffect(() => { setSelectedIds(new Set()) }, [page])

  // Only email_ready leads are eligible for Bulk Send, regardless of source.
  const emailReadyLeads = leads.filter(l => l.status === 'email_ready')
  const bulkSendEligibleLeads = emailReadyLeads
  // new leads → research action
  const researchEligibleLeads = leads.filter(l => l.status === 'new')
  // researched leads → Initial Email generation action
  const processEligibleLeads = leads.filter(l => l.status === 'researched')
  // combined for row checkboxes and select-all
  const selectableLeads = [...emailReadyLeads, ...researchEligibleLeads, ...processEligibleLeads]

  const selectedEmailReadyLeads = emailReadyLeads.filter(l => selectedIds.has(l.id))
  const selectedBulkSendLeads = bulkSendEligibleLeads.filter(l => selectedIds.has(l.id))
  const selectedNewLeads = researchEligibleLeads.filter(l => selectedIds.has(l.id))
  const selectedResearchedLeads = processEligibleLeads.filter(l => selectedIds.has(l.id))

  const allSelectableSelected = selectableLeads.length > 0 && selectableLeads.every(l => selectedIds.has(l.id))
  const someSelectableSelected = selectableLeads.some(l => selectedIds.has(l.id))

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = someSelectableSelected && !allSelectableSelected
    }
  }, [someSelectableSelected, allSelectableSelected])

  function toggleSelect(id: string, e: React.ChangeEvent<HTMLInputElement> | React.MouseEvent) {
    e.stopPropagation()
    setSelectedIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  function handleSelectAll() {
    if (allSelectableSelected) {
      setSelectedIds(prev => {
        const next = new Set(prev)
        selectableLeads.forEach(l => next.delete(l.id))
        return next
      })
    } else {
      setSelectedIds(prev => {
        const next = new Set(prev)
        selectableLeads.forEach(l => next.add(l.id))
        return next
      })
    }
  }

  async function runBulkAction() {
    if (!bulkAction || bulkRunning || operationActiveRef.current) return
    const action = bulkAction
    const actionMap: Record<BulkAction, string> = {
      send:       'send_initial_emails',
      delete:     'delete',
      research:   'research_leads',
      process:    'process_researched_leads',
    }
    const leadIds = action === 'send'
      ? selectedBulkSendLeads.map(l => l.id)
      : action === 'research'
        ? selectedNewLeads.map(l => l.id)
        : action === 'process'
          ? selectedResearchedLeads.map(l => l.id)
        : Array.from(selectedIds)
    if (leadIds.length === 0) return

    operationActiveRef.current = true
    setBulkRunning(true)
    setBulkResult(null)

    try {
      let initialEmailMode: 'ai_personalised' | 'template' | null = null
      if (action !== 'delete') {
        try {
          initialEmailMode = await captureInitialEmailModeSnapshot()
        } catch (error) {
          const reason = `Operation did not start: ${error instanceof Error ? error.message : 'Unable to resolve Initial Email mode'}`
          const outcomes: LeadsBulkOutcome[] = leadIds.map((leadId) => ({ lead_id: leadId, status: 'failed', reason }))
          const progress = summarizeLeadsBulkOutcomes(leadIds.length, outcomes)
          setBulkProgress(progress)
          setBulkResult({ progress, outcomes })
          return
        }
      }
      const result = await runSequentialLeadsBulkOperation({
        targetIds: leadIds,
        request: async (leadId) => {
          const res = await fetch('/api/leads/bulk', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: actionMap[action],
              lead_ids: [leadId],
              ...(initialEmailMode ? { initial_email_mode: initialEmailMode } : {}),
            }),
          })
          const json = await res.json() as LeadsBulkOperationResponse
          const confirmed = json.outcomes?.find((item) => item.lead_id === leadId)
          if (!res.ok || !confirmed) throw new Error(json.error ?? 'The server did not confirm an outcome')
          return confirmed
        },
        failureOutcome: (leadId, error) => {
          const reason = action === 'send'
            ? 'Delivery outcome could not be confirmed. The request was not retried; verify this lead before sending again.'
            : error instanceof Error ? error.message : 'The request failed'
          return { lead_id: leadId, status: 'failed', reason }
        },
        onProgress: (nextProgress) => setBulkProgress(nextProgress),
      })
      setBulkResult(result)
    } finally {
      setBulkRunning(false)
      operationActiveRef.current = false
      void fetchLeads()
    }
  }

  function openBulkDialog(action: BulkAction) {
    if (operationActiveRef.current) return
    setBulkResult(null)
    setBulkProgress(createLeadsBulkProgress(0))
    setBulkAction(action)
  }

  function closeBulkModal() {
    if (bulkRunning) return
    setBulkAction(null)
    setBulkResult(null)
    if (bulkResult !== null) {
      setSelectedIds(new Set())
    }
  }

  function openRegenerateDialog() {
    if (operationActiveRef.current) return
    const filteredIdsRequestSequence = ++filteredIdsRequestSequenceRef.current
    filteredIdsRequestRef.current?.abort()
    const filteredIdsController = new AbortController()
    filteredIdsRequestRef.current = filteredIdsController
    const filterSnapshot = createLeadsFilterSnapshot({
      rawSearch: search,
      status,
      stage: initialStage,
      city,
    })
    const isCurrentFilteredIdsRequest = () => (
      filteredIdsRequestSequence === filteredIdsRequestSequenceRef.current
      && !filteredIdsController.signal.aborted
    )

    setRegenerateScope('selected')
    setFilteredEligible(null)
    setFilteredEligibleLoading(false)
    setRegenerateResult(null)
    setRegenerateProgress(createLeadsBulkProgress(0))
    setRegenerateOpen(true)
    fetch('/api/leads/regenerate-emails')
      .then((response) => response.json())
      .then((json: { mode?: 'ai_personalised' | 'template' }) => setRegenerateMode(json.mode ?? null))
      .catch(() => setRegenerateMode(null))

    // "All filtered" is only unambiguous when the page is scoped to email_ready —
    // fetch the true eligible count/ids across every page (not just this one).
    if (filterSnapshot.status === 'email_ready') {
      setFilteredEligibleLoading(true)
      const snapshotParams = createLeadsFilterSearchParams(filterSnapshot)
      snapshotParams.set('ids_only', 'true')

      void (async () => {
        const eligibleById = new Map<string, { id: string }>()
        let idsPage = 1
        let filteredTotal = Number.POSITIVE_INFINITY

        try {
          while (eligibleById.size < filteredTotal) {
            const params = new URLSearchParams(snapshotParams)
            params.set('page', String(idsPage))
            params.set('page_size', String(FILTERED_IDS_PAGE_SIZE))
            const response = await fetch(`/api/leads?${params}`, { signal: filteredIdsController.signal })
            const json = await response.json() as { data?: Array<{ id: string }>; count?: number; limit?: number }
            if (!response.ok) throw new Error('Failed to load filtered lead IDs')
            if (!isCurrentFilteredIdsRequest()) return

            const ids = json.data ?? []
            filteredTotal = json.count ?? 0
            ids.forEach((lead) => eligibleById.set(lead.id, lead))
            if (ids.length < (json.limit ?? FILTERED_IDS_PAGE_SIZE)) break
            idsPage += 1
          }
          if (!isCurrentFilteredIdsRequest()) return
          setFilteredEligible(Array.from(eligibleById.values()))
        } catch (error) {
          if (!isCurrentFilteredIdsRequest()) return
          if (error instanceof DOMException && error.name === 'AbortError') return
          setFilteredEligible([])
        } finally {
          if (isCurrentFilteredIdsRequest()) setFilteredEligibleLoading(false)
        }
      })()
    }
  }

  function closeRegenerateDialog() {
    if (regenerateRunning) return
    filteredIdsRequestSequenceRef.current += 1
    filteredIdsRequestRef.current?.abort()
    setFilteredEligibleLoading(false)
    setRegenerateOpen(false)
    if (regenerateResult !== null) {
      setSelectedIds(new Set())
    }
  }

  async function runRegenerate() {
    if (regenerateRunning || operationActiveRef.current) return

    const targets = regenerateScope === 'filtered' && filteredEligible
      ? filteredEligible
      : selectedEmailReadyLeads.map((l) => ({ id: l.id }))

    const targetBatches = createUniqueIdBatches(targets.map((lead) => lead.id))
    const targetCount = targetBatches.reduce((count, batch) => count + batch.length, 0)

    if (targetCount === 0 || !regenerateMode) return

    operationActiveRef.current = true
    setRegenerateRunning(true)

    try {
      const targetIds = targetBatches.flat()
      const result = await runSequentialLeadsBulkOperation({
        targetIds,
        request: async (leadId) => {
          const res = await fetch('/api/leads/regenerate-emails', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lead_ids: [leadId], mode: regenerateMode }),
          })
          const json = await res.json() as LeadsBulkOperationResponse
          const confirmed = json.outcomes?.find((item) => item.lead_id === leadId)
          if (!res.ok || !confirmed) throw new Error(json.error ?? 'The server did not confirm an outcome')
          return confirmed
        },
        failureOutcome: (leadId, error) => ({
          lead_id: leadId,
          status: 'failed',
          reason: error instanceof Error ? error.message : 'Regeneration failed',
        }),
        onProgress: (nextProgress) => setRegenerateProgress(nextProgress),
      })
      setRegenerateResult({ ...result, mode: regenerateMode })
    } finally {
      setRegenerateRunning(false)
      operationActiveRef.current = false
      void fetchLeads()
    }
  }

  const totalPages = Math.ceil(total / LEADS_PAGE_SIZE)

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
            onChange={(e) => { invalidateFilteredIdsLookup(); setSearch(e.target.value); setPage(1) }}
            className="flex-1 bg-transparent text-sm text-white placeholder-gray-500 outline-none min-w-0"
          />
        </div>

        <div className="flex flex-wrap gap-2 items-center">
          <select
            value={status}
            onChange={(e) => { invalidateFilteredIdsLookup(); setStatus(e.target.value); setPage(1) }}
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
            onChange={(e) => { invalidateFilteredIdsLookup(); setCity(e.target.value); setPage(1) }}
            className="px-3 py-2 rounded-lg text-sm text-white outline-none"
            style={{ background: '#0f1117', border: '1px solid #2a2d3e' }}
          >
            <option value="">All Cities</option>
            {cities.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>

          {(search || status || city) && (
            <Button variant="ghost" size="sm" onClick={() => { invalidateFilteredIdsLookup(); setSearch(''); setStatus(''); setCity(''); setPage(1) }}>
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

          {selectableLeads.length > 0 && !allSelectableSelected && (
            <button
              onClick={handleSelectAll}
              className="text-xs transition-colors hover:opacity-80"
              style={{ color: '#64748b' }}
            >
              Select all ({selectableLeads.length})
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
                onClick={() => openBulkDialog('research')}
              >
                <Microscope size={12} />
                Research Selected ({selectedNewLeads.length})
              </Button>
            )}
            {selectedResearchedLeads.length > 0 && (
              <Button
                size="sm"
                onClick={() => openBulkDialog('process')}
              >
                <Mail size={12} />
                Process to Email Ready ({selectedResearchedLeads.length})
              </Button>
            )}
            {selectedEmailReadyLeads.length > 0 && (
              <>
                {selectedBulkSendLeads.length > 0 && (
                  <Button
                    size="sm"
                    onClick={() => openBulkDialog('send')}
                  >
                    <Send size={12} />
                    Send Initial Emails
                  </Button>
                )}
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
                  onClick={() => openBulkDialog('delete')}
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
              {/* Checkbox header */}
              <th className="w-10 px-3 py-3">
                {selectableLeads.length > 0 && (
                  <input
                    ref={selectAllRef}
                    type="checkbox"
                    checked={allSelectableSelected}
                    onChange={handleSelectAll}
                    onClick={(e) => e.stopPropagation()}
                    title="Select all leads"
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
            ) : loadError ? (
              <tr>
                <td colSpan={10} className="px-4 py-8 text-center">
                  <div className="inline-flex items-center gap-2 text-sm" style={{ color: '#f87171' }}>
                    <span>{loadError}</span>
                    <Button size="sm" variant="ghost" onClick={() => void fetchLeads()}>
                      Retry
                    </Button>
                  </div>
                </td>
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
                const isResearched  = lead.status === 'researched'
                const isSelectable  = isEmailReady || isNew || isResearched
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
                      {isSelectable && (
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={(e) => toggleSelect(lead.id, e)}
                          className="w-3.5 h-3.5 rounded cursor-pointer"
                          style={{ accentColor: '#38bdf8' }}
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
          count={bulkAction === 'send' ? selectedBulkSendLeads.length : bulkAction === 'research' ? selectedNewLeads.length : bulkAction === 'process' ? selectedResearchedLeads.length : selectedIds.size}
          running={bulkRunning}
          progress={bulkProgress}
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
        mode={regenerateMode}
        onConfirm={runRegenerate}
        onClose={closeRegenerateDialog}
      />
    </div>
  )
}
