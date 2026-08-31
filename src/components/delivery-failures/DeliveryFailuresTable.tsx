'use client'

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import {
  selectableLeadIds,
  setLeadSelected,
  setPageSelected,
} from '@/lib/delivery-failure-selection'
import { formatDateTime } from '@/lib/utils'
import type {
  DeliveryFailureEmailType,
  DeliveryFailureRecord,
  DeliveryFailureStatus,
  DeliveryFailureSummary,
} from '@/lib/delivery-failure-report'

const PAGE_SIZE = 50

const TYPE_LABELS: Record<DeliveryFailureEmailType, string> = {
  initial_pitch: 'Initial',
  follow_up_1: 'Follow-up 1',
  follow_up_2: 'Follow-up 2',
  follow_up_3: 'Follow-up 3',
  reactivation: 'Reactivation',
}

const STATUS_LABELS: Record<DeliveryFailureStatus, string> = {
  bounced: 'Bounced',
  failed: 'Failed',
  suppressed: 'Suppressed',
}

const STATUS_COLORS: Record<DeliveryFailureStatus, string> = {
  bounced: 'bg-orange-500/20 text-orange-300',
  failed: 'bg-red-500/20 text-red-300',
  suppressed: 'bg-purple-500/20 text-purple-300',
}

interface DeliveryFailureResponse {
  data?: DeliveryFailureRecord[]
  total?: number
  page?: number
  page_size?: number
  total_pages?: number
  summary?: DeliveryFailureSummary
  error?: string
}

interface LeadSelectionResponse {
  count?: number
  lead_ids?: string[]
  error?: string
}

interface BulkDeleteResponse {
  deleted?: number
  missing?: number
  error?: string
}

const EMPTY_SUMMARY: DeliveryFailureSummary = { total: 0, bounced: 0, failed: 0, suppressed: 0 }

export function DeliveryFailuresTable() {
  const [rows, setRows] = useState<DeliveryFailureRecord[]>([])
  const [summary, setSummary] = useState<DeliveryFailureSummary>(EMPTY_SUMMARY)
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [statusFilter, setStatusFilter] = useState('')
  const [typeFilter, setTypeFilter] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<DeliveryFailureRecord | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [selectedLeadIds, setSelectedLeadIds] = useState<Set<string>>(() => new Set())
  const [allFilteredSelected, setAllFilteredSelected] = useState(false)
  const [filteredLeadCount, setFilteredLeadCount] = useState(0)
  const [selectionLoading, setSelectionLoading] = useState(false)
  const [selectionError, setSelectionError] = useState<string | null>(null)
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false)
  const [bulkDeleting, setBulkDeleting] = useState(false)
  const [bulkDeleteError, setBulkDeleteError] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)
  const requestSequence = useRef(0)
  const selectionSequence = useRef(0)
  const pageCheckbox = useRef<HTMLInputElement>(null)

  const buildFilterParams = useCallback(() => {
    const params = new URLSearchParams()
    if (statusFilter) params.set('status', statusFilter)
    if (typeFilter) params.set('type', typeFilter)
    if (search) params.set('search', search)
    return params
  }, [search, statusFilter, typeFilter])

  const fetchFailures = useCallback(async (signal?: AbortSignal) => {
    const sequence = ++requestSequence.current
    setLoading(true)
    setError(null)
    const params = buildFilterParams()
    params.set('page', String(page))
    params.set('page_size', String(PAGE_SIZE))

    try {
      const response = await fetch(`/api/delivery-failures?${params}`, { signal })
      const json = await response.json() as DeliveryFailureResponse
      if (!response.ok) throw new Error(json.error ?? 'Could not load delivery failures')
      if (sequence !== requestSequence.current) return
      setRows(json.data ?? [])
      setTotal(json.total ?? 0)
      setSummary(json.summary ?? EMPTY_SUMMARY)
    } catch (requestError) {
      if (requestError instanceof DOMException && requestError.name === 'AbortError') return
      if (sequence === requestSequence.current) {
        setError(requestError instanceof Error ? requestError.message : 'Could not load delivery failures')
      }
    } finally {
      if (sequence === requestSequence.current) setLoading(false)
    }
  }, [buildFilterParams, page])

  const fetchLeadSelection = useCallback(async (includeIds: boolean, signal?: AbortSignal) => {
    const sequence = ++selectionSequence.current
    const params = buildFilterParams()
    if (includeIds) params.set('include_ids', 'true')
    const response = await fetch(`/api/delivery-failures/lead-selection?${params}`, { signal })
    const json = await response.json() as LeadSelectionResponse
    if (!response.ok) throw new Error(json.error ?? 'Could not load selectable leads')
    if (sequence !== selectionSequence.current) return null
    setFilteredLeadCount(json.count ?? 0)
    return json
  }, [buildFilterParams])

  useEffect(() => {
    const controller = new AbortController()
    void fetchFailures(controller.signal)
    return () => controller.abort()
  }, [fetchFailures])

  useEffect(() => {
    const controller = new AbortController()
    setSelectionError(null)
    void fetchLeadSelection(false, controller.signal).catch((requestError) => {
      if (requestError instanceof DOMException && requestError.name === 'AbortError') return
      setSelectionError(requestError instanceof Error ? requestError.message : 'Could not load selectable leads')
    })
    return () => controller.abort()
  }, [fetchLeadSelection])

  useEffect(() => {
    setPage(1)
    setSelectedLeadIds(new Set())
    setAllFilteredSelected(false)
    setSelectionError(null)
  }, [search, statusFilter, typeFilter])

  const currentPageLeadIds = useMemo(() => selectableLeadIds(rows), [rows])
  const selectedOnPage = currentPageLeadIds.filter((id) => selectedLeadIds.has(id)).length
  const allPageSelected = currentPageLeadIds.length > 0 && selectedOnPage === currentPageLeadIds.length
  const somePageSelected = selectedOnPage > 0 && !allPageSelected

  useEffect(() => {
    if (pageCheckbox.current) pageCheckbox.current.indeterminate = somePageSelected
  }, [somePageSelected])

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSearch(searchInput.trim())
  }

  function clearSearch() {
    setSearchInput('')
    setSearch('')
  }

  function clearSelection() {
    setSelectedLeadIds(new Set())
    setAllFilteredSelected(false)
    setSelectionError(null)
  }

  function toggleRow(leadId: string, checked: boolean) {
    setSelectedLeadIds((selected) => setLeadSelected(selected, leadId, checked))
    setAllFilteredSelected(false)
  }

  function toggleCurrentPage(checked: boolean) {
    setSelectedLeadIds((selected) => setPageSelected(selected, rows, checked))
    setAllFilteredSelected(false)
  }

  function changePage(nextPage: number) {
    // Manual/current-page selections are cleared before they become hidden.
    // An explicit all-filtered selection remains selected across pagination.
    if (!allFilteredSelected) clearSelection()
    setPage(nextPage)
  }

  async function selectAllFiltered() {
    setSelectionLoading(true)
    setSelectionError(null)
    try {
      const json = await fetchLeadSelection(true)
      if (!json) return
      setSelectedLeadIds(new Set(json.lead_ids ?? []))
      setAllFilteredSelected(true)
    } catch (requestError) {
      setSelectionError(requestError instanceof Error ? requestError.message : 'Could not select filtered leads')
    } finally {
      setSelectionLoading(false)
    }
  }

  function openDelete(row: DeliveryFailureRecord) {
    setDeleteTarget(row)
    setDeleteError(null)
  }

  function closeDelete() {
    if (deleting) return
    setDeleteTarget(null)
    setDeleteError(null)
  }

  async function refreshAfterDelete() {
    clearSelection()
    if (page === 1) await fetchFailures()
    else setPage(1)
    try {
      await fetchLeadSelection(false)
    } catch {
      // The report refresh remains useful even if the optional selection count fails.
    }
  }

  async function confirmDelete() {
    if (!deleteTarget?.lead_id) return
    setDeleting(true)
    setDeleteError(null)
    try {
      const response = await fetch(`/api/leads/${deleteTarget.lead_id}`, { method: 'DELETE' })
      const json = await response.json() as { error?: string }
      if (!response.ok) throw new Error(json.error ?? 'Could not delete lead')
      setDeleteTarget(null)
      setSuccessMessage('Lead deleted from the active lead database.')
      await refreshAfterDelete()
    } catch (requestError) {
      setDeleteError(requestError instanceof Error ? requestError.message : 'Could not delete lead')
    } finally {
      setDeleting(false)
    }
  }

  function openBulkDelete() {
    if (selectedLeadIds.size === 0) return
    setBulkDeleteError(null)
    setBulkConfirmOpen(true)
  }

  function closeBulkDelete() {
    if (bulkDeleting) return
    setBulkConfirmOpen(false)
    setBulkDeleteError(null)
  }

  async function confirmBulkDelete() {
    if (selectedLeadIds.size === 0) return
    const leadIds = [...selectedLeadIds]
    setBulkDeleting(true)
    setBulkDeleteError(null)
    try {
      const response = await fetch('/api/leads/bulk-delete', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lead_ids: leadIds }),
      })
      const json = await response.json() as BulkDeleteResponse
      if (!response.ok) throw new Error(json.error ?? 'Could not delete selected leads')
      const deleted = json.deleted ?? 0
      const missing = json.missing ?? 0
      setBulkConfirmOpen(false)
      setSuccessMessage(
        `Deleted ${deleted} lead${deleted === 1 ? '' : 's'} from the active lead database.`
        + (missing > 0 ? ` ${missing} had already been deleted.` : ''),
      )
      await refreshAfterDelete()
    } catch (requestError) {
      setBulkDeleteError(requestError instanceof Error ? requestError.message : 'Could not delete selected leads')
    } finally {
      setBulkDeleting(false)
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const selectedCount = selectedLeadIds.size

  return (
    <div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 p-4 md:p-5 border-b" style={{ borderColor: '#2a2d3e' }}>
        {[
          { label: 'Total Failures', value: summary.total, color: '#e2e8f0' },
          { label: 'Bounced', value: summary.bounced, color: '#fdba74' },
          { label: 'Failed', value: summary.failed, color: '#f87171' },
          { label: 'Suppressed', value: summary.suppressed, color: '#c4b5fd' },
        ].map(({ label, value, color }) => (
          <div key={label}>
            <p className="text-xs" style={{ color: '#64748b' }}>{label}</p>
            <p className="text-xl md:text-2xl font-bold mt-0.5" style={{ color }}>{value}</p>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap gap-2 px-4 py-3 border-b" style={{ borderColor: '#2a2d3e' }}>
        <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} aria-label="Failure status" className="px-3 py-2 rounded-lg text-sm text-white outline-none" style={{ background: '#0f1117', border: '1px solid #2a2d3e' }}>
          <option value="">All Failures</option>
          <option value="bounced">Bounced</option>
          <option value="failed">Failed</option>
          <option value="suppressed">Suppressed</option>
        </select>
        <select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)} aria-label="Email type" className="px-3 py-2 rounded-lg text-sm text-white outline-none" style={{ background: '#0f1117', border: '1px solid #2a2d3e' }}>
          <option value="">All Email Types</option>
          {Object.entries(TYPE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <form onSubmit={submitSearch} className="flex gap-2 flex-1 min-w-64">
          <input value={searchInput} onChange={(event) => setSearchInput(event.target.value)} placeholder="Search business or email" aria-label="Search business or email" className="min-w-0 flex-1 px-3 py-2 rounded-lg text-sm text-white outline-none" style={{ background: '#0f1117', border: '1px solid #2a2d3e' }} />
          <Button size="sm" variant="secondary" type="submit">Search</Button>
          {search && <Button size="sm" variant="ghost" type="button" onClick={clearSearch}>Clear</Button>}
        </form>
        <span className="self-center text-xs" style={{ color: '#64748b' }}>{total} result{total === 1 ? '' : 's'}</span>
      </div>

      <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b" style={{ borderColor: '#2a2d3e', background: '#151822' }}>
        <Button size="sm" variant="danger" onClick={openBulkDelete} disabled={selectedCount === 0 || bulkDeleting}>
          Delete Selected{selectedCount > 0 ? ` (${selectedCount})` : ''}
        </Button>
        {filteredLeadCount > 0 && !allFilteredSelected && (
          <Button size="sm" variant="secondary" onClick={() => void selectAllFiltered()} disabled={selectionLoading}>
            {selectionLoading ? 'Selecting...' : `Select all ${filteredLeadCount} filtered leads`}
          </Button>
        )}
        {selectedCount > 0 && <Button size="sm" variant="ghost" onClick={clearSelection}>Clear selection</Button>}
        <span className="text-xs" style={{ color: allFilteredSelected ? '#7dd3fc' : '#94a3b8' }}>
          {allFilteredSelected
            ? `All ${selectedCount} unique leads matching the current filters are selected.`
            : `${selectedCount} unique lead${selectedCount === 1 ? '' : 's'} selected. Header checkbox affects the current page only.`}
        </span>
        {selectionError && <span className="text-xs" style={{ color: '#f87171' }}>{selectionError}</span>}
      </div>

      {successMessage && (
        <div role="status" aria-live="polite" className="px-4 py-3 text-sm border-b" style={{ color: '#86efac', borderColor: '#2a2d3e', background: '#14532d33' }}>
          {successMessage}
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr style={{ borderBottom: '1px solid #2a2d3e' }}>
              <th className="px-4 py-3 text-left">
                <input
                  ref={pageCheckbox}
                  type="checkbox"
                  checked={allPageSelected}
                  disabled={currentPageLeadIds.length === 0 || loading}
                  onChange={(event) => toggleCurrentPage(event.target.checked)}
                  aria-label="Select all unique leads on the current page"
                  className="h-4 w-4 accent-sky-600"
                />
              </th>
              {['Business / Email', 'Category / City', 'Status', 'Email Type', 'Failure Date', 'Provider / ID', 'Failure Reason', 'Actions'].map((label, index) => (
                <th key={label} className={`${[1, 4, 5].includes(index) ? 'hidden lg:table-cell ' : ''}px-4 py-3 text-left text-xs font-medium uppercase tracking-wider`} style={{ color: '#64748b' }}>{label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={9} className="px-4 py-12 text-center" style={{ color: '#64748b' }}>Loading...</td></tr>
            ) : error ? (
              <tr><td colSpan={9} className="px-4 py-12 text-center" style={{ color: '#f87171' }}>{error}</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={9} className="px-4 py-12 text-center" style={{ color: '#64748b' }}>No delivery failures found.</td></tr>
            ) : rows.map((row) => (
              <tr key={row.email_id} className="border-b align-top" style={{ borderColor: '#1e2130' }}>
                <td className="px-4 py-3">
                  {row.lead_id && (
                    <input
                      type="checkbox"
                      checked={selectedLeadIds.has(row.lead_id)}
                      onChange={(event) => toggleRow(row.lead_id!, event.target.checked)}
                      aria-label={`Select ${row.business_name ?? row.email_address ?? 'lead'}`}
                      className="h-4 w-4 accent-sky-600"
                    />
                  )}
                </td>
                <td className="px-4 py-3 min-w-52">
                  <div className="font-medium text-white">{row.business_name ?? 'Deleted or missing lead'}</div>
                  <div className="text-xs mt-1 break-all" style={{ color: '#94a3b8' }}>{row.email_address ?? 'Email address unavailable'}</div>
                </td>
                <td className="hidden lg:table-cell px-4 py-3 text-xs" style={{ color: '#94a3b8' }}>
                  <div>{row.category ?? '—'}</div><div className="mt-1" style={{ color: '#64748b' }}>{row.city ?? '—'}</div>
                </td>
                <td className="px-4 py-3">
                  <span className={`text-xs px-2.5 py-1 rounded-full font-medium ${STATUS_COLORS[row.failure_status]}`}>{STATUS_LABELS[row.failure_status]}</span>
                  {row.failure_source === 'local_api' && <div className="text-[11px] mt-1.5" style={{ color: '#fca5a5' }}>Local/API send failure</div>}
                </td>
                <td className="px-4 py-3"><span className="text-xs px-2 py-1 rounded-full whitespace-nowrap" style={{ background: '#2a2d3e', color: '#94a3b8' }}>{TYPE_LABELS[row.email_type]}</span></td>
                <td className="hidden lg:table-cell px-4 py-3 text-xs whitespace-nowrap" style={{ color: '#94a3b8' }}>{formatDateTime(row.failure_date)}</td>
                <td className="hidden lg:table-cell px-4 py-3 text-xs max-w-44" style={{ color: '#94a3b8' }}>
                  <div>{row.provider}</div><div className="mt-1 truncate" title={row.resend_id ?? undefined} style={{ color: '#64748b' }}>{row.resend_id ?? 'No Resend ID'}</div>
                </td>
                <td className="px-4 py-3 text-xs min-w-56 max-w-sm" style={{ color: '#cbd5e1' }}>{row.failure_reason}</td>
                <td className="px-4 py-3">{row.lead_id && <Button size="sm" variant="danger" onClick={() => openDelete(row)}>Delete Lead</Button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between p-4 border-t" style={{ borderColor: '#2a2d3e' }}>
        <Button size="sm" variant="secondary" disabled={page <= 1 || loading} onClick={() => changePage(page - 1)}>Previous</Button>
        <span className="text-xs" style={{ color: '#64748b' }}>Page {page} of {totalPages}</span>
        <Button size="sm" variant="secondary" disabled={page >= totalPages || loading} onClick={() => changePage(page + 1)}>Next</Button>
      </div>

      <Modal open={!!deleteTarget} onClose={closeDelete} title="Delete lead?">
        {deleteTarget && <div className="space-y-4">
          <p className="text-sm" style={{ color: '#cbd5e1' }}>This will permanently delete the lead and its related records using the existing lead deletion flow.</p>
          <div className="rounded-lg p-3 text-sm" style={{ background: '#0f1117', border: '1px solid #2a2d3e' }}>
            <div className="font-medium text-white">{deleteTarget.business_name ?? 'Unknown business'}</div>
            <div className="text-xs mt-1 break-all" style={{ color: '#94a3b8' }}>{deleteTarget.email_address ?? 'Email unavailable'}</div>
          </div>
          {deleteError && <p className="text-sm" style={{ color: '#f87171' }}>{deleteError}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={closeDelete} disabled={deleting}>Cancel</Button>
            <Button variant="danger" onClick={() => void confirmDelete()} disabled={deleting}>{deleting ? 'Deleting...' : 'Delete Lead'}</Button>
          </div>
        </div>}
      </Modal>

      <Modal open={bulkConfirmOpen} onClose={closeBulkDelete} title={`Delete ${selectedCount} selected leads?`}>
        <div className="space-y-4">
          <p className="text-sm" style={{ color: '#cbd5e1' }}>
            This will permanently remove the selected leads and businesses from the active lead database. Historical delivery-failure activity may remain for auditing.
          </p>
          <p className="text-sm font-medium" style={{ color: '#fca5a5' }}>This action cannot be undone.</p>
          {bulkDeleteError && <p className="text-sm" style={{ color: '#f87171' }}>{bulkDeleteError}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={closeBulkDelete} disabled={bulkDeleting}>Cancel</Button>
            <Button variant="danger" onClick={() => void confirmBulkDelete()} disabled={bulkDeleting}>
              {bulkDeleting ? 'Deleting...' : `Delete ${selectedCount} Leads`}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
