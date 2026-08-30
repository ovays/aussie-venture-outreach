'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { formatDate, formatDateTime } from '@/lib/utils'

interface EmailRecord {
  id: string
  type: 'initial_pitch' | 'follow_up_1' | 'follow_up_2' | 'follow_up_3'
  subject: string
  status: 'pending_send' | 'sent' | 'failed' | 'bounced' | 'suppressed' | 'email_sync_failed'
  sent_at: string | null
  replied_at: string | null
  created_at: string
  leads: { business_name: string; category_name: string; city: string } | null
}

interface EmailDetail extends EmailRecord {
  body_html: string
  body_text: string
}

interface EmailSummary {
  total_contacted_leads: number
  positive_response_leads: number
  reply_rate: number
  matching_bounced: number
}

const TYPE_LABELS: Record<string, string> = {
  initial_pitch: 'Initial', follow_up_1: 'Follow-up 1', follow_up_2: 'Follow-up 2', follow_up_3: 'Follow-up 3',
}
const STATUS_COLORS: Record<string, string> = {
  sent: 'bg-green-500/20 text-green-400', failed: 'bg-red-500/20 text-red-400', bounced: 'bg-orange-500/20 text-orange-400', suppressed: 'bg-red-500/20 text-red-300', pending_send: 'bg-yellow-500/20 text-yellow-400', email_sync_failed: 'bg-purple-500/20 text-purple-400',
}
const STATUS_LABELS: Record<string, string> = {
  sent: 'Sent', failed: 'Failed', bounced: 'Bounced', suppressed: 'Suppressed', pending_send: 'Pending', email_sync_failed: 'Sync Failed',
}

export function EmailLogTable() {
  const [emails, setEmails] = useState<EmailRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedEmailRow, setSelectedEmailRow] = useState<EmailRecord | null>(null)
  const [selectedEmail, setSelectedEmail] = useState<EmailDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [typeFilter, setTypeFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [summary, setSummary] = useState<EmailSummary | null>(null)
  const listSequence = useRef(0)
  const detailSequence = useRef(0)
  const detailController = useRef<AbortController | null>(null)

  const fetchEmails = useCallback(async (signal: AbortSignal, sequence: number) => {
    setLoading(true)
    setError(null)
    const params = new URLSearchParams({ page: String(page), page_size: '50' })
    if (typeFilter) params.set('type', typeFilter)
    if (statusFilter) params.set('status', statusFilter)
    try {
      const response = await fetch(`/api/email-log?${params}`, { signal })
      const json = await response.json() as { data?: EmailRecord[]; total?: number; summary?: EmailSummary; error?: string }
      if (!response.ok) throw new Error(json.error ?? 'Email Log request failed')
      if (sequence !== listSequence.current) return
      setEmails(json.data ?? [])
      setTotal(json.total ?? 0)
      setSummary(json.summary ?? null)
    } catch (requestError) {
      if (requestError instanceof DOMException && requestError.name === 'AbortError') return
      if (sequence === listSequence.current) setError(requestError instanceof Error ? requestError.message : 'Email Log request failed')
    } finally {
      if (sequence === listSequence.current) setLoading(false)
    }
  }, [page, statusFilter, typeFilter])

  useEffect(() => {
    const controller = new AbortController()
    const sequence = ++listSequence.current
    void fetchEmails(controller.signal, sequence)
    return () => controller.abort()
  }, [fetchEmails])

  useEffect(() => setPage(1), [typeFilter, statusFilter])

  async function fetchEmailDetail(id: string) {
    detailController.current?.abort()
    const controller = new AbortController()
    detailController.current = controller
    const sequence = ++detailSequence.current
    setDetailLoading(true)
    setDetailError(null)
    try {
      const response = await fetch(`/api/emails/${id}`, { signal: controller.signal })
      const json = await response.json() as { data?: EmailDetail; error?: string }
      if (!response.ok || !json.data) throw new Error(json.error ?? 'Could not load email')
      if (sequence !== detailSequence.current) return
      setSelectedEmail(json.data)
    } catch (requestError) {
      if (!(requestError instanceof DOMException && requestError.name === 'AbortError')) {
        if (sequence === detailSequence.current) {
          setDetailError(requestError instanceof Error ? requestError.message : 'Could not load email')
        }
      }
    } finally {
      if (sequence === detailSequence.current) setDetailLoading(false)
    }
  }

  function openEmail(email: EmailRecord) {
    setSelectedEmailRow(email)
    setSelectedEmail(null)
    setDetailError(null)
    void fetchEmailDetail(email.id)
  }

  function closeEmail() {
    detailController.current?.abort()
    detailController.current = null
    detailSequence.current++
    setSelectedEmailRow(null)
    setSelectedEmail(null)
    setDetailLoading(false)
    setDetailError(null)
  }

  const totalSent = summary?.total_contacted_leads ?? 0
  const totalReplied = summary?.positive_response_leads ?? 0
  const replyRate = summary?.reply_rate ?? 0
  const bounceRate = totalSent > 0 ? Math.round(((summary?.matching_bounced ?? 0) / totalSent) * 100) : 0
  const totalPages = Math.max(1, Math.ceil(total / 50))

  return (
    <div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 p-4 md:p-5 border-b" style={{ borderColor: '#2a2d3e' }}>
        {[
          { label: 'Contacted Leads', value: totalSent, color: '#38bdf8' },
          { label: 'Positive Replies', value: totalReplied, color: '#4ade80' },
          { label: 'Reply Rate', value: `${replyRate}%`, color: '#a78bfa' },
          { label: 'Bounce Rate', value: `${bounceRate}%`, color: '#f87171' },
        ].map(({ label, value, color }) => <div key={label}><p className="text-xs" style={{ color: '#64748b' }}>{label}</p><p className="text-xl md:text-2xl font-bold mt-0.5" style={{ color }}>{value}</p></div>)}
      </div>

      <div className="flex flex-wrap gap-2 px-4 py-3 border-b" style={{ borderColor: '#2a2d3e' }}>
        <select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)} className="px-3 py-2 rounded-lg text-sm text-white outline-none" style={{ background: '#0f1117', border: '1px solid #2a2d3e' }}>
          <option value="">All Types</option><option value="initial_pitch">Initial</option><option value="follow_up_1">Follow-up 1</option><option value="follow_up_2">Follow-up 2</option><option value="follow_up_3">Follow-up 3</option>
        </select>
        <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} className="px-3 py-2 rounded-lg text-sm text-white outline-none" style={{ background: '#0f1117', border: '1px solid #2a2d3e' }}>
          <option value="">All Statuses</option><option value="sent">Sent</option><option value="failed">Failed</option><option value="bounced">Bounced</option><option value="suppressed">Suppressed</option><option value="pending_send">Pending</option><option value="email_sync_failed">Sync Failed</option>
        </select>
        <span className="ml-auto self-center text-xs" style={{ color: '#64748b' }}>{total} email{total === 1 ? '' : 's'}</span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr style={{ borderBottom: '1px solid #2a2d3e' }}>
            {['Business', 'Type', 'Subject', 'Status', 'Sent At', 'Replied', 'Actions'].map((label, index) => <th key={label} className={`${[2, 4, 5].includes(index) ? 'hidden md:table-cell ' : ''}px-4 py-3 text-left text-xs font-medium uppercase tracking-wider`} style={{ color: '#64748b' }}>{label}</th>)}
          </tr></thead>
          <tbody>
            {loading ? <tr><td colSpan={7} className="px-4 py-12 text-center" style={{ color: '#64748b' }}>Loading…</td></tr>
              : error ? <tr><td colSpan={7} className="px-4 py-12 text-center" style={{ color: '#f87171' }}>{error}</td></tr>
              : emails.length === 0 ? <tr><td colSpan={7} className="px-4 py-12 text-center" style={{ color: '#64748b' }}>No emails found</td></tr>
              : emails.map((email) => <tr key={email.id} className="border-b" style={{ borderColor: '#1e2130' }}>
                <td className="px-4 py-3"><div className="font-medium text-white">{email.leads?.business_name ?? '—'}</div><div className="text-xs mt-0.5" style={{ color: '#64748b' }}>{email.leads?.city}</div></td>
                <td className="px-4 py-3"><span className="text-xs px-2 py-1 rounded-full" style={{ background: '#2a2d3e', color: '#94a3b8' }}>{TYPE_LABELS[email.type]}</span></td>
                <td className="hidden md:table-cell px-4 py-3 max-w-xs"><p className="text-sm truncate" style={{ color: '#e2e8f0' }}>{email.subject}</p></td>
                <td className="px-4 py-3"><span className={`text-xs px-2.5 py-1 rounded-full font-medium ${STATUS_COLORS[email.status] ?? ''}`}>{STATUS_LABELS[email.status] ?? email.status}</span></td>
                <td className="hidden md:table-cell px-4 py-3 text-xs" style={{ color: '#64748b' }}>{email.sent_at ? formatDateTime(email.sent_at) : '—'}</td>
                <td className="hidden md:table-cell px-4 py-3">{email.replied_at ? <span className="text-xs text-green-400">Yes</span> : <span className="text-xs" style={{ color: '#475569' }}>No</span>}</td>
                <td className="px-4 py-3"><Button size="sm" variant="secondary" onClick={() => openEmail(email)}>View</Button></td>
              </tr>)}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between p-4 border-t" style={{ borderColor: '#2a2d3e' }}>
        <Button size="sm" variant="secondary" disabled={page <= 1 || loading} onClick={() => setPage((value) => value - 1)}>Previous</Button>
        <span className="text-xs" style={{ color: '#64748b' }}>Page {page} of {totalPages}</span>
        <Button size="sm" variant="secondary" disabled={page >= totalPages || loading} onClick={() => setPage((value) => value + 1)}>Next</Button>
      </div>

      <Modal open={!!selectedEmailRow} onClose={closeEmail} title={selectedEmailRow?.subject ?? ''} wide>
        {detailLoading && <p className="py-8 text-center text-sm" style={{ color: '#64748b' }}>Loading…</p>}
        {!detailLoading && detailError && <div className="space-y-4 py-4 text-center">
          <p className="text-sm" style={{ color: '#f87171' }}>{detailError}</p>
          <Button size="sm" variant="secondary" onClick={() => selectedEmailRow && void fetchEmailDetail(selectedEmailRow.id)}>Retry</Button>
        </div>}
        {!detailLoading && selectedEmail && <div className="space-y-4">
          <div className="flex flex-wrap gap-4 text-sm" style={{ color: '#94a3b8' }}><span>To: <strong className="text-white">{selectedEmail.leads?.business_name}</strong></span><span>Type: <strong className="text-white">{TYPE_LABELS[selectedEmail.type]}</strong></span>{selectedEmail.sent_at && <span>Sent: <strong className="text-white">{formatDate(selectedEmail.sent_at)}</strong></span>}</div>
          <div className="rounded-lg p-4 text-sm max-h-96 overflow-y-auto" style={{ background: '#0f1117', border: '1px solid #2a2d3e', color: '#e2e8f0' }} dangerouslySetInnerHTML={{ __html: selectedEmail.body_html }} />
        </div>}
      </Modal>
    </div>
  )
}
