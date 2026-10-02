'use client'

import { useCallback, useEffect, useState } from 'react'
import { Building2, ChevronLeft, ChevronRight, Mail, MapPin, Search, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { CUSTOMER_LEAD_STATUSES, CUSTOMER_LEAD_STATUS_LABELS, type CustomerLeadFilter, type CustomerLeadStatus } from '@/lib/customer-lead'
import { formatDate, timeAgo } from '@/lib/utils'

interface LeadRow {
  id: string
  business_name: string
  category_name: string
  location: string
  email: string | null
  customer_status: CustomerLeadStatus
  last_contact_at: string | null
  has_reply: boolean
}

interface ListResponse {
  data?: LeadRow[]
  total?: number
  page?: number
  page_size?: number
  counts?: Partial<Record<CustomerLeadFilter, number>>
  error?: string
}

interface DetailResponse {
  data?: {
    id: string; business_name: string; category_name: string; location: string
    email: string | null; phone: string | null; website: string | null
    notes: string | null; customer_outcome: 'interested' | 'not_interested' | null
    status: CustomerLeadStatus; last_contact_at: string | null
    latest_reply: { subject: string | null; replied_at: string | null } | null
    suppression: { label: string; suppressed_at: string } | null
    activity: Array<{ id: string; text: string; created_at: string }>
    capabilities: { edit_notes: boolean; edit_outcome: boolean; do_not_contact: boolean }
  }
  error?: string
}

const STATUS_TONES: Record<CustomerLeadStatus, string> = {
  new: 'bg-sky-500/10 text-sky-300 border-sky-500/20',
  email_ready: 'bg-amber-500/10 text-amber-300 border-amber-500/20',
  contacted: 'bg-orange-500/10 text-orange-300 border-orange-500/20',
  replied: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20',
  interested: 'bg-violet-500/10 text-violet-300 border-violet-500/20',
  not_interested: 'bg-slate-500/10 text-slate-300 border-slate-500/20',
  reactivation_due: 'bg-rose-500/10 text-rose-300 border-rose-500/20',
  dead: 'bg-gray-500/10 text-gray-400 border-gray-500/20',
}

function CustomerStatusBadge({ status }: { status: CustomerLeadStatus }) {
  return <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-medium ${STATUS_TONES[status]}`}>{CUSTOMER_LEAD_STATUS_LABELS[status]}</span>
}

function LeadDetail({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const [detail, setDetail] = useState<DetailResponse['data']>()
  const [notes, setNotes] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    const response = await fetch(`/api/customer-leads/${id}`)
    const body = await response.json() as DetailResponse
    if (!response.ok || !body.data) return setError(body.error ?? 'Could not load this lead')
    setDetail(body.data); setNotes(body.data.notes ?? '')
  }, [id])
  useEffect(() => { void load() }, [load])

  async function update(payload: { outcome?: 'interested' | 'not_interested' | null; notes?: string | null; do_not_contact?: true }) {
    setSaving(true); setError('')
    const response = await fetch(`/api/customer-leads/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
    const body = await response.json() as { error?: string }
    setSaving(false)
    if (!response.ok) return setError(body.error ?? 'Could not save changes')
    await load(); onChanged()
  }

  return <div className="fixed inset-0 z-50 flex justify-end bg-black/55" role="dialog" aria-modal="true" aria-label="Lead details">
    <button className="flex-1 cursor-default" aria-label="Close lead details" onClick={onClose} />
    <aside className="h-full w-full max-w-lg overflow-y-auto border-l border-[var(--border-subtle)] bg-[var(--surface)] shadow-2xl">
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-[var(--border-subtle)] bg-[var(--surface)] px-5 py-4">
        <div><p className="text-xs text-[var(--text-muted)]">Lead details</p><h2 className="font-semibold text-[var(--text-primary)]">{detail?.business_name ?? 'Loading…'}</h2></div>
        <button onClick={onClose} className="rounded-lg p-2 text-[var(--text-muted)] hover:bg-[var(--surface-hover)]"><X size={18} /></button>
      </div>
      {error && <p className="m-5 rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-300">{error}</p>}
      {detail && <div className="space-y-6 p-5">
        <section><div className="mb-3 flex items-center justify-between"><h3 className="text-sm font-semibold text-[var(--text-primary)]">Business</h3><CustomerStatusBadge status={detail.status} /></div>
          <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
            <div><dt className="text-xs text-[var(--text-muted)]">Category</dt><dd className="text-[var(--text-secondary)]">{detail.category_name || '—'}</dd></div>
            <div><dt className="text-xs text-[var(--text-muted)]">Location</dt><dd className="text-[var(--text-secondary)]">{detail.location || '—'}</dd></div>
            <div><dt className="text-xs text-[var(--text-muted)]">Email</dt><dd className="break-all text-[var(--text-secondary)]">{detail.email || '—'}</dd></div>
            <div><dt className="text-xs text-[var(--text-muted)]">Phone</dt><dd className="text-[var(--text-secondary)]">{detail.phone || '—'}</dd></div>
          </dl>
        </section>
        <section className="rounded-xl border border-[var(--border-subtle)] bg-[var(--background-subtle)] p-4"><h3 className="text-sm font-semibold text-[var(--text-primary)]">Outreach summary</h3>
          <p className="mt-2 text-sm text-[var(--text-secondary)]">{detail.last_contact_at ? `Last contacted ${formatDate(detail.last_contact_at)}` : 'No outreach has been sent yet.'}</p>
          <p className="mt-1 text-sm text-[var(--text-secondary)]">{detail.latest_reply?.replied_at ? `Latest reply ${timeAgo(detail.latest_reply.replied_at)}${detail.latest_reply.subject ? ` · ${detail.latest_reply.subject}` : ''}` : 'No reply received yet.'}</p>
        </section>
        <section><h3 className="mb-2 text-sm font-semibold text-[var(--text-primary)]">Outcome</h3>
          {detail.capabilities.edit_outcome ? <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => update({ outcome: 'interested' })} disabled={saving || detail.customer_outcome === 'interested'}>Mark Interested</Button>
            <Button size="sm" variant="ghost" onClick={() => update({ outcome: 'not_interested' })} disabled={saving || detail.customer_outcome === 'not_interested'}>Mark Not Interested</Button>
            {detail.customer_outcome && <Button size="sm" variant="ghost" onClick={() => update({ outcome: null })} disabled={saving}>Clear outcome</Button>}
          </div> : <p className="text-sm text-[var(--text-muted)]">Workspace owners and admins manage outcomes.</p>}
        </section>
        <section><h3 className="mb-2 text-sm font-semibold text-[var(--text-primary)]">Sending safety</h3>{detail.suppression?<p className="text-sm font-medium text-rose-300">{detail.suppression.label} · future outreach is blocked</p>:detail.capabilities.do_not_contact?<Button size="sm" variant="secondary" onClick={() => { if(confirm('Stop all future outreach to this email address?')) void update({do_not_contact:true}) }} disabled={saving}>Do not contact</Button>:<p className="text-sm text-[var(--text-muted)]">No sending restriction is recorded.</p>}</section>
        <section><h3 className="mb-2 text-sm font-semibold text-[var(--text-primary)]">Notes</h3>
          <textarea value={notes} onChange={(event) => setNotes(event.target.value)} disabled={!detail.capabilities.edit_notes} maxLength={5000} rows={5} placeholder="Add context for your team…" className="w-full resize-y rounded-lg border border-[var(--border-subtle)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--primary)]" />
          {detail.capabilities.edit_notes && <Button size="sm" className="mt-2" onClick={() => update({ notes })} disabled={saving}>{saving ? 'Saving…' : 'Save notes'}</Button>}
        </section>
        {detail.activity.length > 0 && <section><h3 className="mb-2 text-sm font-semibold text-[var(--text-primary)]">Recent activity</h3><div className="space-y-2">{detail.activity.slice(0, 8).map((event) => <div key={event.id} className="flex justify-between gap-4 rounded-lg bg-[var(--background-subtle)] px-3 py-2 text-sm"><span className="text-[var(--text-secondary)]">{event.text}</span><span className="shrink-0 text-xs text-[var(--text-muted)]">{timeAgo(event.created_at)}</span></div>)}</div></section>}
      </div>}
    </aside>
  </div>
}

export function CustomerLeads({ initialStatus = 'all' }: { initialStatus?: CustomerLeadFilter }) {
  const [rows, setRows] = useState<LeadRow[]>([])
  const [counts, setCounts] = useState<Partial<Record<CustomerLeadFilter, number>>>({})
  const [filter, setFilter] = useState<CustomerLeadFilter>(initialStatus)
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<string | null>(null)

  useEffect(() => { const timer = setTimeout(() => { setDebouncedSearch(search.trim()); setPage(1) }, 300); return () => clearTimeout(timer) }, [search])
  const load = useCallback(async () => {
    setLoading(true); setError('')
    const params = new URLSearchParams({ status: filter, page: String(page), page_size: '25' })
    if (debouncedSearch) params.set('search', debouncedSearch)
    const response = await fetch(`/api/customer-leads?${params}`)
    const body = await response.json() as ListResponse
    setLoading(false)
    if (!response.ok) return setError(body.error ?? 'Could not load leads')
    setRows(body.data ?? []); setTotal(Number(body.total ?? 0)); setCounts(body.counts ?? {})
  }, [filter, page, debouncedSearch])
  useEffect(() => { void load() }, [load])

  const pageCount = Math.max(1, Math.ceil(total / 25))
  return <>
    <div className="border-b border-[var(--border-subtle)] p-4 sm:p-5">
      <div className="mb-4"><h2 className="text-lg font-semibold text-[var(--text-primary)]">Leads</h2><p className="text-sm text-[var(--text-muted)]">Businesses in your outreach workspace</p></div>
      <div className="mb-4 flex gap-2 overflow-x-auto pb-1">{CUSTOMER_LEAD_STATUSES.map((status) => <button key={status} onClick={() => { setFilter(status); setPage(1) }} className={`shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium ${filter === status ? 'border-[var(--primary)] bg-[var(--primary-muted)] text-[var(--primary)]' : 'border-[var(--border-subtle)] text-[var(--text-muted)] hover:text-[var(--text-primary)]'}`}>{CUSTOMER_LEAD_STATUS_LABELS[status]}{counts[status] !== undefined ? ` ${counts[status]}` : ''}</button>)}</div>
      <label className="flex max-w-md items-center gap-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--background)] px-3 py-2"><Search size={16} className="text-[var(--text-muted)]" /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search business, email, location or category" className="w-full bg-transparent text-sm text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]" /></label>
    </div>
    {error && <p className="m-5 rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-300">{error}</p>}
    {!loading && !error && total === 0 && filter === 'all' && !debouncedSearch ? <div className="flex flex-col items-center px-6 py-20 text-center"><span className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-[var(--primary-muted)] text-[var(--primary)]"><Building2 size={23} /></span><h3 className="font-semibold text-[var(--text-primary)]">No leads yet</h3><p className="mt-1 max-w-md text-sm text-[var(--text-muted)]">Businesses will appear here once outreach targeting and discovery are activated. Your workspace remains paused until then.</p></div>
      : <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="border-b border-[var(--border-subtle)] text-xs text-[var(--text-muted)]"><th className="px-5 py-3 font-medium">Business</th><th className="px-4 py-3 font-medium">Category</th><th className="px-4 py-3 font-medium">Location</th><th className="px-4 py-3 font-medium">Status</th><th className="px-4 py-3 font-medium">Last contact</th><th className="px-4 py-3 font-medium">Reply</th><th className="px-5 py-3 text-right font-medium">Action</th></tr></thead><tbody>{loading ? <tr><td colSpan={7} className="px-5 py-16 text-center text-[var(--text-muted)]">Loading leads…</td></tr> : rows.length === 0 ? <tr><td colSpan={7} className="px-5 py-16 text-center text-[var(--text-muted)]">No leads match these filters.</td></tr> : rows.map((lead) => <tr key={lead.id} className="border-b border-[var(--border-subtle)] hover:bg-[var(--surface-hover)]"><td className="px-5 py-3"><p className="font-medium text-[var(--text-primary)]">{lead.business_name}</p><p className="mt-0.5 flex items-center gap-1 text-xs text-[var(--text-muted)]"><Mail size={11} />{lead.email || 'No email'}</p></td><td className="px-4 py-3 text-[var(--text-secondary)]">{lead.category_name || '—'}</td><td className="px-4 py-3 text-[var(--text-secondary)]"><span className="flex items-center gap-1"><MapPin size={12} />{lead.location || '—'}</span></td><td className="px-4 py-3"><CustomerStatusBadge status={lead.customer_status} /></td><td className="px-4 py-3 text-[var(--text-secondary)]">{lead.last_contact_at ? formatDate(lead.last_contact_at) : '—'}</td><td className="px-4 py-3 text-[var(--text-secondary)]">{lead.has_reply ? 'Replied' : '—'}</td><td className="px-5 py-3 text-right"><button onClick={() => setSelected(lead.id)} className="text-xs font-medium text-[var(--primary)] hover:underline">View details</button></td></tr>)}</tbody></table></div>}
    {total > 0 && <div className="flex items-center justify-between border-t border-[var(--border-subtle)] px-5 py-3"><span className="text-xs text-[var(--text-muted)]">{total.toLocaleString()} lead{total === 1 ? '' : 's'}</span><div className="flex items-center gap-2"><Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}><ChevronLeft size={15} /></Button><span className="text-xs text-[var(--text-muted)]">{page} of {pageCount}</span><Button size="sm" variant="ghost" disabled={page >= pageCount} onClick={() => setPage((value) => value + 1)}><ChevronRight size={15} /></Button></div></div>}
    {selected && <LeadDetail id={selected} onClose={() => setSelected(null)} onChanged={() => void load()} />}
  </>
}
