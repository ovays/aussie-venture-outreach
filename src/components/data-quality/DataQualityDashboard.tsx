'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent } from 'react'
import { ChevronDown, ChevronRight, RefreshCw, ShieldAlert } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Modal } from '@/components/ui/Modal'
import { StatusBadge } from '@/components/ui/Badge'
import { useLeadDrawer } from '@/lib/lead-drawer-context'
import type { DataQualityLeadDetail, DataQualityOwnership } from '@/lib/data-quality-report'
import { DuplicateConsolidationModal } from '@/components/data-quality/DuplicateConsolidationModal'

type IssueType = 'duplicate_lead' | 'shared_email' | 'uncertain_email_group' | 'already_contacted_email' | 'placeholder_email' | 'technical_email' | 'invalid_email'

interface Summary {
  duplicate_lead_groups: number
  shared_email_groups: number
  uncertain_email_groups: number
  placeholder_emails: number
  technical_emails: number
  invalid_emails: number
  already_contacted_email_leads: number
  protected_duplicate_records: number
  safe_looking_duplicate_candidates: number
}

interface ReportRow {
  issue_type: IssueType
  normalized_email: string | null
  lead_count: number
  lead_ids: string[]
  business_names: string[]
  statuses: string[]
  outreach_count: number
  latest_outreach_at: string | null
  protected_from_auto_delete: boolean
  preferred_lead_id: string | null
  suggested_redundant_lead_ids: string[]
  reasons: string[]
  leads: DataQualityLeadDetail[]
  ownership: DataQualityOwnership | null
}

interface ReportResponse {
  data?: ReportRow[]
  total?: number
  total_pages?: number
  summary?: Partial<Summary>
  error?: string
}

const EMPTY_SUMMARY: Summary = {
  duplicate_lead_groups: 0, shared_email_groups: 0, uncertain_email_groups: 0,
  placeholder_emails: 0, technical_emails: 0, invalid_emails: 0,
  already_contacted_email_leads: 0, protected_duplicate_records: 0,
  safe_looking_duplicate_candidates: 0,
}

const ISSUE_LABELS: Record<IssueType, string> = {
  duplicate_lead: 'Duplicate Lead', shared_email: 'Shared Email', uncertain_email_group: 'Uncertain',
  already_contacted_email: 'Already Contacted', placeholder_email: 'Placeholder',
  technical_email: 'Technical', invalid_email: 'Invalid',
}

const ISSUE_STYLES: Record<IssueType, string> = {
  duplicate_lead: 'bg-amber-500/15 text-amber-300', shared_email: 'bg-violet-500/15 text-violet-300',
  uncertain_email_group: 'bg-slate-500/20 text-slate-300', already_contacted_email: 'bg-sky-500/15 text-sky-300',
  placeholder_email: 'bg-orange-500/15 text-orange-300', technical_email: 'bg-fuchsia-500/15 text-fuchsia-300',
  invalid_email: 'bg-red-500/15 text-red-300',
}

const TABS: Array<{ value: '' | IssueType; label: string }> = [
  { value: '', label: 'All' }, { value: 'duplicate_lead', label: 'Duplicate Leads' },
  { value: 'shared_email', label: 'Shared Emails' }, { value: 'uncertain_email_group', label: 'Uncertain' },
  { value: 'already_contacted_email', label: 'Already Contacted' }, { value: 'placeholder_email', label: 'Placeholder' },
  { value: 'technical_email', label: 'Technical' }, { value: 'invalid_email', label: 'Invalid' },
]

const JUNK_ISSUES = new Set<IssueType>(['placeholder_email', 'technical_email', 'invalid_email'])

function formatDate(value: string | null | undefined): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('en-AU', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

function groupKey(row: ReportRow): string {
  return `${row.issue_type}:${row.normalized_email ?? row.lead_ids.join(',')}`
}

function isSafelySelectable(row: ReportRow): boolean {
  return JUNK_ISSUES.has(row.issue_type) && row.leads.length === 1
    && !row.leads[0].protected_from_auto_delete && !row.leads[0].is_outreach_owner
}

function emptyMessage(issueType: '' | IssueType, hasFilters: boolean): string {
  if (hasFilters) return 'No results match the current filters.'
  if (issueType === 'duplicate_lead') return 'No duplicate lead groups found.'
  if (issueType === 'technical_email') return 'No technical email issues found.'
  if (issueType) return `No ${ISSUE_LABELS[issueType].toLowerCase()} issues found.`
  return 'No open data-quality issues found.'
}

export function DataQualityDashboard() {
  const { openDrawer } = useLeadDrawer()
  const [rows, setRows] = useState<ReportRow[]>([])
  const [summary, setSummary] = useState<Summary>(EMPTY_SUMMARY)
  const [total, setTotal] = useState(0)
  const [totalPages, setTotalPages] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [issueType, setIssueType] = useState<'' | IssueType>('')
  const [searchInput, setSearchInput] = useState('')
  const [cityInput, setCityInput] = useState('')
  const [categoryInput, setCategoryInput] = useState('')
  const [filters, setFilters] = useState({ search: '', city: '', category: '' })
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [removeTargets, setRemoveTargets] = useState<DataQualityLeadDetail[] | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<DataQualityLeadDetail | null>(null)
  const [consolidationTarget, setConsolidationTarget] = useState<ReportRow | null>(null)
  const [protectedConfirmed, setProtectedConfirmed] = useState(false)
  const [lastResolution, setLastResolution] = useState<{ row: ReportRow } | null>(null)
  const sequence = useRef(0)
  const pageCheckbox = useRef<HTMLInputElement>(null)

  const fetchReport = useCallback(async (signal?: AbortSignal) => {
    const current = ++sequence.current
    setLoading(true)
    setError(null)
    const params = new URLSearchParams({ page: String(page), page_size: String(pageSize) })
    if (issueType) params.set('issue_type', issueType)
    if (filters.search) params.set('search', filters.search)
    if (filters.city) params.set('city', filters.city)
    if (filters.category) params.set('category', filters.category)
    try {
      const response = await fetch(`/api/data-quality?${params}`, { signal })
      const json = await response.json() as ReportResponse
      if (!response.ok) throw new Error(json.error ?? 'Unable to load the Data Quality report.')
      if (current !== sequence.current) return
      setRows(json.data ?? [])
      setTotal(json.total ?? 0)
      setTotalPages(json.total_pages ?? 0)
      setSummary({ ...EMPTY_SUMMARY, ...(json.summary ?? {}) })
      setSelected(new Set())
    } catch (requestError) {
      if (requestError instanceof DOMException && requestError.name === 'AbortError') return
      if (current === sequence.current) setError(requestError instanceof Error ? requestError.message : 'Unable to load the Data Quality report.')
    } finally {
      if (current === sequence.current) setLoading(false)
    }
  }, [filters, issueType, page, pageSize])

  useEffect(() => {
    const controller = new AbortController()
    void fetchReport(controller.signal)
    return () => controller.abort()
  }, [fetchReport])

  const selectableRows = useMemo(() => rows.filter(isSafelySelectable), [rows])
  const selectedRows = useMemo(() => rows.filter((row) => selected.has(groupKey(row))), [rows, selected])
  const allSelectableSelected = selectableRows.length > 0 && selectableRows.every((row) => selected.has(groupKey(row)))
  const someSelectableSelected = selectableRows.some((row) => selected.has(groupKey(row))) && !allSelectableSelected
  useEffect(() => { if (pageCheckbox.current) pageCheckbox.current.indeterminate = someSelectableSelected }, [someSelectableSelected])

  function chooseIssue(next: '' | IssueType) {
    setIssueType(next); setPage(1); setExpanded(new Set()); setSelected(new Set())
  }

  function submitFilters(event: FormEvent) {
    event.preventDefault()
    setFilters({ search: searchInput.trim(), city: cityInput.trim(), category: categoryInput.trim() })
    setPage(1)
  }

  function clearFilters() {
    setSearchInput(''); setCityInput(''); setCategoryInput('')
    setFilters({ search: '', city: '', category: '' }); setPage(1)
  }

  function toggleExpanded(row: ReportRow) {
    const key = groupKey(row)
    setExpanded((current) => {
      const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next
    })
  }

  function toggleSelected(row: ReportRow, checked: boolean) {
    setSelected((current) => {
      const next = new Set(current); if (checked) next.add(groupKey(row)); else next.delete(groupKey(row)); return next
    })
  }

  function toggleAllSelected(checked: boolean) {
    setSelected(checked ? new Set(selectableRows.map(groupKey)) : new Set())
  }

  async function postAction(body: Record<string, unknown>) {
    const response = await fetch('/api/data-quality/actions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    const json = await response.json() as { error?: string }
    if (!response.ok) throw new Error(json.error ?? 'The Data Quality action could not be completed.')
  }

  function flagIdentity(row: ReportRow) {
    return {
      issue_type: row.issue_type,
      normalized_email: row.normalized_email,
      ...(JUNK_ISSUES.has(row.issue_type) || row.issue_type === 'already_contacted_email' ? { lead_ids: row.lead_ids } : {}),
    }
  }

  async function resolveRow(row: ReportRow) {
    setBusy(true); setError(null); setMessage(null)
    try {
      await postAction({ action: 'resolve', ...flagIdentity(row), reason: 'Reviewed in Admin Data Quality' })
      setLastResolution({ row })
      setMessage('Issue marked resolved. No lead data was deleted or merged.')
      await fetchReport()
    } catch (actionError) { setError(actionError instanceof Error ? actionError.message : 'Resolution failed.') }
    finally { setBusy(false) }
  }

  async function reopenLast() {
    if (!lastResolution) return
    setBusy(true); setError(null)
    try {
      await postAction({ action: 'reopen', ...flagIdentity(lastResolution.row) })
      setLastResolution(null); setMessage('Issue reopened.'); await fetchReport()
    } catch (actionError) { setError(actionError instanceof Error ? actionError.message : 'Reopen failed.') }
    finally { setBusy(false) }
  }

  async function confirmRemoveEmail() {
    if (!removeTargets?.length) return
    setBusy(true); setError(null)
    try {
      await postAction({ action: 'remove_email', lead_ids: removeTargets.map((lead) => lead.id) })
      setRemoveTargets(null); setMessage(`Removed ${removeTargets.length} invalid or junk email${removeTargets.length === 1 ? '' : 's'}. Business records were kept.`)
      await fetchReport()
    } catch (actionError) { setError(actionError instanceof Error ? actionError.message : 'Email removal failed.') }
    finally { setBusy(false) }
  }

  async function confirmDelete() {
    if (!deleteTarget) return
    setBusy(true); setError(null)
    try {
      await postAction({ action: 'delete_lead', lead_id: deleteTarget.id, confirm_protected: protectedConfirmed })
      setDeleteTarget(null); setProtectedConfirmed(false); setMessage('Lead deleted through the safe Data Quality workflow.')
      await fetchReport()
    } catch (actionError) { setError(actionError instanceof Error ? actionError.message : 'Lead deletion failed.') }
    finally { setBusy(false) }
  }

  async function bulkResolve() {
    if (!selectedRows.length) return
    setBusy(true); setError(null)
    try {
      const byIssue = new Map<IssueType, string[]>()
      for (const row of selectedRows) byIssue.set(row.issue_type, [...(byIssue.get(row.issue_type) ?? []), ...row.lead_ids])
      await Promise.all([...byIssue].map(([type, leadIds]) => postAction({
        action: 'resolve', issue_type: type, lead_ids: [...new Set(leadIds)], reason: 'Bulk reviewed in Admin Data Quality',
      })))
      setMessage(`Resolved ${selectedRows.length} selected flag${selectedRows.length === 1 ? '' : 's'} without changing leads.`)
      await fetchReport()
    } catch (actionError) { setError(actionError instanceof Error ? actionError.message : 'Bulk resolution failed.') }
    finally { setBusy(false) }
  }

  const invalidJunk = summary.invalid_emails + summary.placeholder_emails + summary.technical_emails
  const hasAppliedFilters = Boolean(filters.search || filters.city || filters.category)

  return <div className="space-y-4 md:space-y-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold text-white">Data Quality</h1>
        <p className="text-sm mt-1 max-w-3xl" style={{ color: '#94a3b8' }}>
          Review recommendations safely. Classification never merges or deletes leads automatically.
        </p>
      </div>
      <Button variant="secondary" onClick={() => void fetchReport()} disabled={loading || busy}>
        <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
      </Button>
    </div>

    <div className="grid grid-cols-2 lg:grid-cols-6 gap-2.5">
      {[
        { label: 'Duplicate Groups', value: summary.duplicate_lead_groups, issue: 'duplicate_lead' as IssueType },
        { label: 'Shared Emails', value: summary.shared_email_groups, issue: 'shared_email' as IssueType },
        { label: 'Uncertain', value: summary.uncertain_email_groups, issue: 'uncertain_email_group' as IssueType },
        { label: 'Invalid / Junk', value: invalidJunk, issue: 'invalid_email' as IssueType, detail: `${summary.invalid_emails} invalid · ${summary.placeholder_emails} placeholder · ${summary.technical_emails} technical` },
        { label: 'Already Contacted', value: summary.already_contacted_email_leads, issue: 'already_contacted_email' as IssueType },
        { label: 'Protected Duplicates', value: summary.protected_duplicate_records, issue: 'duplicate_lead' as IssueType },
      ].map((card) => <button key={card.label} onClick={() => chooseIssue(card.issue)} className="text-left rounded-xl p-3 hover:border-sky-700 transition-colors" style={{ background: '#1e2130', border: '1px solid #2a2d3e' }}>
        <div className="text-xs" style={{ color: '#64748b' }}>{card.label}</div>
        <div className="text-xl font-bold text-white mt-1">{card.value}</div>
        {card.detail && <div className="text-[10px] mt-1 leading-4" style={{ color: '#94a3b8' }}>{card.detail}</div>}
      </button>)}
    </div>

    <Card className="!p-0 overflow-hidden">
      <div className="flex gap-1 px-3 pt-3 overflow-x-auto border-b" style={{ borderColor: '#2a2d3e' }}>
        {TABS.map((tab) => <button key={tab.value || 'all'} onClick={() => chooseIssue(tab.value)} className="px-3 py-2 text-xs font-medium whitespace-nowrap border-b-2" style={{ color: issueType === tab.value ? '#38bdf8' : '#94a3b8', borderColor: issueType === tab.value ? '#0284c7' : 'transparent' }}>{tab.label}</button>)}
      </div>

      <form onSubmit={submitFilters} className="flex flex-wrap gap-2 p-3 border-b" style={{ borderColor: '#2a2d3e' }}>
        <input value={searchInput} onChange={(event) => setSearchInput(event.target.value)} aria-label="Search business, email, or domain" placeholder="Search business, email, or domain..." className="min-w-64 flex-1 px-3 py-2 rounded-lg text-sm text-white outline-none" style={{ background: '#0f1117', border: '1px solid #2a2d3e' }} />
        <input value={cityInput} onChange={(event) => setCityInput(event.target.value)} aria-label="City" placeholder="City" className="w-36 px-3 py-2 rounded-lg text-sm text-white outline-none" style={{ background: '#0f1117', border: '1px solid #2a2d3e' }} />
        <input value={categoryInput} onChange={(event) => setCategoryInput(event.target.value)} aria-label="Category" placeholder="Category" className="w-44 px-3 py-2 rounded-lg text-sm text-white outline-none" style={{ background: '#0f1117', border: '1px solid #2a2d3e' }} />
        <Button size="sm" variant="secondary" type="submit">Apply</Button>
        {hasAppliedFilters && <Button size="sm" variant="ghost" type="button" onClick={clearFilters}>Clear</Button>}
      </form>

      <div className="flex flex-wrap items-center gap-2 p-3 border-b" style={{ borderColor: '#2a2d3e', background: '#151822' }}>
        <Button size="sm" variant="secondary" disabled={!selectedRows.length || busy} onClick={() => void bulkResolve()}>Resolve selected ({selectedRows.length})</Button>
        <Button size="sm" variant="danger" disabled={!selectedRows.length || busy} onClick={() => setRemoveTargets(selectedRows.flatMap((row) => row.leads))}>Remove selected invalid emails</Button>
        <span className="text-xs" style={{ color: '#64748b' }}>Only unprotected, non-owner junk-email rows can be selected. Bulk lead deletion is unavailable.</span>
      </div>

      {message && <div role="status" className="flex items-center gap-2 px-4 py-3 text-sm border-b" style={{ color: '#86efac', background: '#14532d33', borderColor: '#2a2d3e' }}>
        <span>{message}</span>{lastResolution && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void reopenLast()}>Undo (Reopen)</Button>}
      </div>}
      {error && <div role="alert" className="px-4 py-3 text-sm border-b" style={{ color: '#fca5a5', background: '#7f1d1d22', borderColor: '#2a2d3e' }}>{error}</div>}

      <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[1120px]">
          <thead><tr style={{ borderBottom: '1px solid #2a2d3e' }}>
            <th className="px-3 py-3 text-left"><input ref={pageCheckbox} type="checkbox" aria-label="Select all safe junk-email rows on this page" checked={allSelectableSelected} disabled={!selectableRows.length || loading} onChange={(event) => toggleAllSelected(event.target.checked)} className="h-4 w-4 accent-sky-600" /></th>
            {['', 'Issue', 'Business / Businesses', 'Email', 'Leads', 'ReachAgent Status', 'Outreach Owner', 'Last Activity', 'Protection', 'Actions'].map((label, index) => <th key={`${label}-${index}`} className="px-3 py-3 text-left text-[11px] font-medium uppercase tracking-wider" style={{ color: '#64748b' }}>{label}</th>)}
          </tr></thead>
          <tbody>
            {loading ? <tr><td colSpan={11} className="px-4 py-14 text-center" style={{ color: '#64748b' }}>Loading Data Quality report...</td></tr>
              : rows.length === 0 ? <tr><td colSpan={11} className="px-4 py-14 text-center" style={{ color: '#64748b' }}>{emptyMessage(issueType, hasAppliedFilters)}</td></tr>
              : rows.map((row) => {
                const key = groupKey(row); const open = expanded.has(key); const owner = row.ownership
                const statuses = [...new Set(row.statuses ?? [])]
                const protectedRow = row.leads.some((lead) => lead.protected_from_auto_delete)
                return <RowFragment key={key} row={row} open={open} owner={owner} statuses={statuses} protectedRow={protectedRow}
                  selected={selected.has(key)} selectable={isSafelySelectable(row)} busy={busy}
                  onToggle={() => toggleExpanded(row)} onSelect={(checked) => toggleSelected(row, checked)}
                  onResolve={() => void resolveRow(row)} onRemove={(lead) => setRemoveTargets([lead])}
                  onDelete={(lead) => { setDeleteTarget(lead); setProtectedConfirmed(false) }} onOpenLead={openDrawer}
                  onConsolidate={() => setConsolidationTarget(row)} />
              })}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 p-3 border-t" style={{ borderColor: '#2a2d3e' }}>
        <span className="text-xs" style={{ color: '#64748b' }}>{total} result{total === 1 ? '' : 's'} · Page {total === 0 ? 0 : page} of {totalPages}</span>
        <div className="flex items-center gap-2">
          <label className="text-xs" style={{ color: '#94a3b8' }}>Rows <select value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1) }} className="ml-1 rounded px-2 py-1 text-white" style={{ background: '#0f1117', border: '1px solid #2a2d3e' }}>{[25, 50, 100].map((size) => <option key={size}>{size}</option>)}</select></label>
          <Button size="sm" variant="secondary" disabled={page <= 1 || loading} onClick={() => setPage((value) => value - 1)}>Previous</Button>
          <Button size="sm" variant="secondary" disabled={page >= totalPages || loading} onClick={() => setPage((value) => value + 1)}>Next</Button>
        </div>
      </div>
    </Card>

    <DuplicateConsolidationModal group={consolidationTarget} onClose={() => setConsolidationTarget(null)} onOpenLead={openDrawer} />

    <Modal open={!!removeTargets} onClose={() => !busy && setRemoveTargets(null)} title={`Remove ${removeTargets?.length ?? 0} invalid email${removeTargets?.length === 1 ? '' : 's'}?`}>
      <div className="space-y-4">
        <p className="text-sm" style={{ color: '#cbd5e1' }}>This sets the selected email field to empty and refreshes its Data Quality state. The business lead is kept.</p>
        <div className="space-y-2">{removeTargets?.map((lead) => <div key={lead.id} className="rounded-lg p-3" style={{ background: '#0f1117', border: '1px solid #2a2d3e' }}><div className="text-sm text-white">{lead.business_name}</div><div className="text-xs break-all mt-1" style={{ color: '#fca5a5' }}>{lead.email}</div></div>)}</div>
        <p className="text-xs" style={{ color: '#94a3b8' }}>Protected leads and current outreach owners are blocked by the server even after confirmation.</p>
        <div className="flex justify-end gap-2"><Button variant="secondary" disabled={busy} onClick={() => setRemoveTargets(null)}>Cancel</Button><Button variant="danger" disabled={busy} onClick={() => void confirmRemoveEmail()}>{busy ? 'Removing...' : 'Remove Email'}</Button></div>
      </div>
    </Modal>

    <Modal open={!!deleteTarget} onClose={() => !busy && setDeleteTarget(null)} title="Delete lead from Data Quality?">
      {deleteTarget && <div className="space-y-4">
        <div className="rounded-lg p-3" style={{ background: '#0f1117', border: '1px solid #2a2d3e' }}><div className="font-medium text-white">{deleteTarget.business_name}</div><div className="text-xs break-all mt-1" style={{ color: '#94a3b8' }}>{deleteTarget.email ?? 'No email'}</div></div>
        {deleteTarget.is_outreach_owner && <div className="rounded-lg p-3 text-sm" style={{ color: '#fca5a5', background: '#7f1d1d22', border: '1px solid #7f1d1d' }}>Deletion is blocked because this lead owns the active recipient outreach lifecycle.</div>}
        {deleteTarget.protection_reasons.length > 0 && <div><p className="text-sm font-medium text-amber-300">Protected record warnings</p><ul className="mt-2 space-y-1 text-sm list-disc pl-5" style={{ color: '#cbd5e1' }}>{deleteTarget.protection_reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul><label className="flex gap-2 mt-3 text-sm" style={{ color: '#fcd34d' }}><input type="checkbox" checked={protectedConfirmed} onChange={(event) => setProtectedConfirmed(event.target.checked)} className="accent-amber-500" />I reviewed these warnings and explicitly confirm protected deletion.</label></div>}
        <p className="text-sm font-medium" style={{ color: '#fca5a5' }}>This permanently deletes the lead through the existing safe deletion workflow. It cannot be undone.</p>
        <div className="flex justify-end gap-2"><Button variant="secondary" disabled={busy} onClick={() => setDeleteTarget(null)}>Cancel</Button><Button variant="danger" disabled={busy || deleteTarget.is_outreach_owner || (deleteTarget.protection_reasons.length > 0 && !protectedConfirmed)} onClick={() => void confirmDelete()}>{busy ? 'Deleting...' : 'Delete Lead'}</Button></div>
      </div>}
    </Modal>
  </div>
}

function RowFragment({ row, open, owner, statuses, protectedRow, selected, selectable, busy, onToggle, onSelect, onResolve, onRemove, onDelete, onOpenLead, onConsolidate }: {
  row: ReportRow; open: boolean; owner: DataQualityOwnership | null; statuses: string[]; protectedRow: boolean
  selected: boolean; selectable: boolean; busy: boolean; onToggle: () => void; onSelect: (checked: boolean) => void
  onResolve: () => void; onRemove: (lead: DataQualityLeadDetail) => void; onDelete: (lead: DataQualityLeadDetail) => void; onOpenLead: (id: string) => void
  onConsolidate: () => void
}) {
  function stop(event: MouseEvent) { event.stopPropagation() }
  return <>
    <tr className="border-b align-top hover:bg-white/[0.02] cursor-pointer" style={{ borderColor: '#1e2130' }} onClick={onToggle}>
      <td className="px-3 py-3" onClick={stop}>{selectable && <input type="checkbox" checked={selected} onChange={(event) => onSelect(event.target.checked)} aria-label={`Select ${row.business_names[0] ?? row.normalized_email}`} className="h-4 w-4 accent-sky-600" />}</td>
      <td className="px-1 py-3">{open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</td>
      <td className="px-3 py-3"><span className={`inline-flex px-2 py-1 rounded-full text-[11px] font-medium whitespace-nowrap ${ISSUE_STYLES[row.issue_type]}`}>{row.issue_type === 'shared_email' ? 'Shared Inbox' : ISSUE_LABELS[row.issue_type]}</span></td>
      <td className="px-3 py-3 min-w-48"><div className="font-medium text-white">{row.lead_count > 1 && row.issue_type === 'shared_email' ? `${row.lead_count} businesses` : row.business_names[0] ?? 'Unknown business'}</div>{row.lead_count > 1 && row.issue_type !== 'shared_email' && <div className="text-xs mt-1" style={{ color: '#64748b' }}>{row.lead_count - 1} related record{row.lead_count === 2 ? '' : 's'}</div>}</td>
      <td className="px-3 py-3 text-xs break-all min-w-48" style={{ color: '#cbd5e1' }}>{row.normalized_email ?? row.leads[0]?.email ?? 'Malformed / unavailable'}</td>
      <td className="px-3 py-3 whitespace-nowrap text-xs" style={{ color: '#94a3b8' }}>{row.lead_count} lead{row.lead_count === 1 ? '' : 's'}</td>
      <td className="px-3 py-3">{statuses.length === 1 ? <StatusBadge status={statuses[0]} /> : <span className="text-xs px-2 py-1 rounded-full bg-slate-500/20 text-slate-300">Mixed</span>}</td>
      <td className="px-3 py-3 text-xs min-w-40"><div className="text-white">{owner?.owner_business_name ?? 'No active owner'}</div>{owner?.owner_lead_id && <div className="mt-1" style={{ color: '#64748b' }}>{row.leads.filter((lead) => lead.outreach_blocked).length} associated lead{row.leads.filter((lead) => lead.outreach_blocked).length === 1 ? '' : 's'} blocked</div>}</td>
      <td className="px-3 py-3 text-xs whitespace-nowrap" style={{ color: '#94a3b8' }}>{formatDate(row.latest_outreach_at)}</td>
      <td className="px-3 py-3">{protectedRow ? <span className="inline-flex items-center gap-1 text-xs text-amber-300"><ShieldAlert size={13} /> Protected</span> : <span className="text-xs" style={{ color: '#64748b' }}>No safeguards triggered</span>}</td>
      <td className="px-3 py-3" onClick={stop}><div className="flex gap-1.5"><Button size="sm" variant="secondary" onClick={onToggle}>Review</Button><Button size="sm" variant="ghost" disabled={busy} onClick={onResolve}>Resolve</Button></div></td>
    </tr>
    {open && <tr className="border-b" style={{ borderColor: '#2a2d3e', background: '#11141d' }}><td colSpan={11} className="p-3 md:p-4">
      <div className="space-y-3">
        {row.issue_type === 'duplicate_lead' && <div className="rounded-lg p-3 text-xs" style={{ color: '#fde68a', background: '#78350f22', border: '1px solid #78350f' }}><strong>Recommendation only:</strong> “Preferred to Keep” is a comparison aid, not an automatic merge decision. Potential duplicates are never deleted or merged automatically.</div>}
        {row.issue_type === 'shared_email' && <div className="rounded-lg p-3 text-xs" style={{ color: '#ddd6fe', background: '#4c1d9522', border: '1px solid #4c1d95' }}><strong>Shared Inbox:</strong> these businesses remain separate. Shared email does not mean duplicate, and no merge action is available.</div>}
        {owner?.owner_lead_id && <div className="rounded-lg p-3 text-xs" style={{ color: '#bae6fd', background: '#0c4a6e22', border: '1px solid #0c4a6e' }}><strong>Outreach owner:</strong> {owner.owner_business_name}. ReachAgent allows one active outreach lifecycle per recipient email to prevent duplicate emails. Other associated leads cannot start independent email outreach.</div>}
        {row.issue_type === 'duplicate_lead' && row.preferred_lead_id !== owner?.owner_lead_id && <div className="rounded-lg p-3 text-xs" style={{ color: '#fde68a', background: '#78350f22', border: '1px solid #92400e' }}><strong>Warning:</strong> Calculated preferred lead differs from the current recipient owner. Selecting a non-owner keep lead requires an atomic ownership transfer.</div>}
        <div className="grid gap-3 xl:grid-cols-2">{row.leads.map((lead) => <LeadComparison key={lead.id} lead={lead} row={row} onRemove={onRemove} onDelete={onDelete} onOpenLead={onOpenLead} />)}</div>
        {row.issue_type === 'duplicate_lead' && <div className="flex justify-end"><Button size="sm" onClick={onConsolidate}>Consolidate Duplicate</Button></div>}
      </div>
    </td></tr>}
  </>
}

function LeadComparison({ lead, row, onRemove, onDelete, onOpenLead }: { lead: DataQualityLeadDetail; row: ReportRow; onRemove: (lead: DataQualityLeadDetail) => void; onDelete: (lead: DataQualityLeadDetail) => void; onOpenLead: (id: string) => void }) {
  const preferred = row.issue_type === 'duplicate_lead' && row.preferred_lead_id === lead.id
  const redundant = row.issue_type === 'duplicate_lead' && row.suggested_redundant_lead_ids.includes(lead.id)
  return <div className="rounded-xl p-3 md:p-4" style={{ background: '#1a1d27', border: preferred ? '1px solid #0ea5e9' : '1px solid #2a2d3e' }}>
    <div className="flex flex-wrap items-start justify-between gap-2"><div><div className="flex flex-wrap items-center gap-2"><h3 className="font-medium text-white">{lead.business_name}</h3>{preferred && <span className="text-[11px] px-2 py-1 rounded-full bg-sky-500/15 text-sky-300">Preferred to Keep</span>}{redundant && <span className="text-[11px] px-2 py-1 rounded-full bg-amber-500/15 text-amber-300">Potential Duplicate</span>}{lead.protected_from_auto_delete && <span className="text-[11px] px-2 py-1 rounded-full bg-amber-500/15 text-amber-300">Protected</span>}</div><div className="text-[11px] mt-1 font-mono" style={{ color: '#64748b' }}>Lead ID: {lead.id}</div></div><StatusBadge status={lead.status} /></div>
    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 mt-4 text-xs">
      <Detail label="Email" value={lead.email} /><Detail label="City / Suburb" value={[lead.city, lead.suburb].filter(Boolean).join(' / ')} />
      <Detail label="Category" value={lead.category} /><Detail label="Created" value={formatDate(lead.created_at)} />
      <Detail label="Website" value={lead.website} /><Detail label="Phone" value={lead.phone} />
      <Detail label="Instagram" value={lead.instagram} /><Detail label="Outreach" value={`${lead.outreach_count} · latest ${formatDate(lead.latest_outreach)}`} />
    </dl>
    <div className="flex flex-wrap gap-1.5 mt-3">{[
      ['Reply', lead.has_reply], ['Deal', lead.has_deal], ['Notes', lead.has_notes], ['Email history', lead.has_email_history],
    ].map(([label, yes]) => <span key={String(label)} className="text-[11px] px-2 py-1 rounded-full" style={{ background: yes ? '#14532d55' : '#2a2d3e', color: yes ? '#86efac' : '#64748b' }}>{label}: {yes ? 'Yes' : 'No'}</span>)}
      {lead.is_outreach_owner && <span className="text-[11px] px-2 py-1 rounded-full bg-sky-500/15 text-sky-300">Outreach Owner</span>}
      {lead.outreach_blocked && <span className="text-[11px] px-2 py-1 rounded-full bg-red-500/15 text-red-300">Independent email outreach blocked</span>}
    </div>
    {lead.protection_reasons.length > 0 && <div className="mt-3 text-xs text-amber-200">Protected because: {lead.protection_reasons.join(' · ')}</div>}
    <div className="flex flex-wrap gap-2 mt-4"><Button size="sm" variant="secondary" onClick={() => onOpenLead(lead.id)}>Open Lead</Button>{JUNK_ISSUES.has(row.issue_type) && <Button size="sm" variant="ghost" disabled={lead.protected_from_auto_delete || lead.is_outreach_owner} title={lead.is_outreach_owner ? 'Current outreach owners cannot have email removed here.' : lead.protected_from_auto_delete ? 'Protected leads cannot use Remove Email.' : undefined} onClick={() => onRemove(lead)}>Remove Email</Button>}{row.issue_type !== 'duplicate_lead' && <Button size="sm" variant="danger" disabled={lead.is_outreach_owner} title={lead.is_outreach_owner ? 'Current outreach owners cannot be deleted here.' : undefined} onClick={() => onDelete(lead)}>Delete Lead</Button>}</div>
  </div>
}

function Detail({ label, value }: { label: string; value: string | null | undefined }) {
  return <div className="min-w-0"><dt style={{ color: '#64748b' }}>{label}</dt><dd className="mt-0.5 text-slate-300 break-words">{value || '—'}</dd></div>
}
