'use client'

import { useState, useEffect, useCallback } from 'react'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { formatDate, formatDateTime } from '@/lib/utils'
import type { DashboardMetrics } from '@/lib/analytics'

interface EmailRecord {
  id: string
  type: 'initial_pitch' | 'follow_up_1' | 'follow_up_2' | 'follow_up_3'
  subject: string
  body_html: string
  body_text: string
  status: 'pending_send' | 'sent' | 'failed' | 'bounced'
  sent_at: string | null
  replied_at: string | null
  created_at: string
  leads: { business_name: string; category_name: string; city: string } | null
}

const TYPE_LABELS: Record<string, string> = {
  initial_pitch: 'Initial',
  follow_up_1: 'Follow-up 1',
  follow_up_2: 'Follow-up 2',
  follow_up_3: 'Follow-up 3',
}

const STATUS_COLORS: Record<string, string> = {
  sent: 'bg-green-500/20 text-green-400',
  failed: 'bg-red-500/20 text-red-400',
  bounced: 'bg-orange-500/20 text-orange-400',
  pending_send: 'bg-yellow-500/20 text-yellow-400',
}

export function EmailLogTable() {
  const [emails, setEmails] = useState<EmailRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedEmail, setSelectedEmail] = useState<EmailRecord | null>(null)
  const [typeFilter, setTypeFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null)

  const fetchEmails = useCallback(async () => {
    setLoading(true)
    const params = new URLSearchParams()
    if (typeFilter) params.set('type', typeFilter)
    if (statusFilter) params.set('status', statusFilter)

    const res = await fetch(`/api/email-log?${params}`)
    const json = await res.json() as { data: EmailRecord[]; metrics?: DashboardMetrics }
    setEmails(json.data ?? [])
    setMetrics(json.metrics ?? null)
    setLoading(false)
  }, [typeFilter, statusFilter])

  useEffect(() => { fetchEmails() }, [fetchEmails])

  const totalSent = metrics?.replyStats.totalContactedLeads ?? emails.filter((e) => e.status === 'sent').length
  const totalReplied = metrics?.replyStats.positiveResponseLeads ?? emails.filter((e) => e.replied_at).length
  const replyRate = metrics?.replyStats.replyRate ?? (totalSent > 0 ? Math.round((totalReplied / totalSent) * 100) : 0)
  const bounced = emails.filter((e) => e.status === 'bounced').length
  const bounceRate = totalSent > 0 ? Math.round((bounced / totalSent) * 100) : 0

  return (
    <div>
      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 p-4 md:p-5 border-b" style={{ borderColor: '#2a2d3e' }}>
        {[
          { label: 'Contacted Leads', value: totalSent,        color: '#38bdf8' },
          { label: 'Positive Replies', value: totalReplied,    color: '#4ade80' },
          { label: 'Reply Rate',   value: `${replyRate}%`,  color: '#a78bfa' },
          { label: 'Bounce Rate',  value: `${bounceRate}%`, color: '#f87171' },
        ].map(({ label, value, color }) => (
          <div key={label}>
            <p className="text-xs" style={{ color: '#64748b' }}>{label}</p>
            <p className="text-xl md:text-2xl font-bold mt-0.5" style={{ color }}>{value}</p>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2 px-4 py-3 border-b" style={{ borderColor: '#2a2d3e' }}>
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          className="px-3 py-2 rounded-lg text-sm text-white outline-none"
          style={{ background: '#0f1117', border: '1px solid #2a2d3e' }}
        >
          <option value="">All Types</option>
          <option value="initial_pitch">Initial</option>
          <option value="follow_up_1">Follow-up 1</option>
          <option value="follow_up_2">Follow-up 2</option>
          <option value="follow_up_3">Follow-up 3</option>
        </select>

        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="px-3 py-2 rounded-lg text-sm text-white outline-none"
          style={{ background: '#0f1117', border: '1px solid #2a2d3e' }}
        >
          <option value="">All Statuses</option>
          <option value="sent">Sent</option>
          <option value="failed">Failed</option>
          <option value="bounced">Bounced</option>
          <option value="pending_send">Pending</option>
        </select>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr style={{ borderBottom: '1px solid #2a2d3e' }}>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider" style={{ color: '#64748b' }}>Business</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider" style={{ color: '#64748b' }}>Type</th>
              <th className="hidden md:table-cell px-4 py-3 text-left text-xs font-medium uppercase tracking-wider" style={{ color: '#64748b' }}>Subject</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider" style={{ color: '#64748b' }}>Status</th>
              <th className="hidden md:table-cell px-4 py-3 text-left text-xs font-medium uppercase tracking-wider" style={{ color: '#64748b' }}>Sent At</th>
              <th className="hidden md:table-cell px-4 py-3 text-left text-xs font-medium uppercase tracking-wider" style={{ color: '#64748b' }}>Replied</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider" style={{ color: '#64748b' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={7} className="px-4 py-12 text-center" style={{ color: '#64748b' }}>Loading...</td></tr>
            ) : emails.length === 0 ? (
              <tr><td colSpan={7} className="px-4 py-12 text-center" style={{ color: '#64748b' }}>No emails found</td></tr>
            ) : (
              emails.map((email) => (
                <tr key={email.id} className="border-b" style={{ borderColor: '#1e2130' }}>
                  <td className="px-4 py-3">
                    <div className="font-medium text-white">{email.leads?.business_name ?? '—'}</div>
                    <div className="text-xs mt-0.5" style={{ color: '#64748b' }}>{email.leads?.city}</div>
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-xs px-2 py-1 rounded-full" style={{ background: '#2a2d3e', color: '#94a3b8' }}>
                      {TYPE_LABELS[email.type]}
                    </span>
                  </td>
                  <td className="hidden md:table-cell px-4 py-3 max-w-xs">
                    <p className="text-sm truncate" style={{ color: '#e2e8f0' }}>{email.subject}</p>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`text-xs px-2.5 py-1 rounded-full font-medium ${STATUS_COLORS[email.status] ?? ''}`}>
                      {email.status.replace('_', ' ')}
                    </span>
                  </td>
                  <td className="hidden md:table-cell px-4 py-3 text-xs" style={{ color: '#64748b' }}>
                    {email.sent_at ? formatDateTime(email.sent_at) : '—'}
                  </td>
                  <td className="hidden md:table-cell px-4 py-3">
                    {email.replied_at ? (
                      <span className="text-xs text-green-400">Yes</span>
                    ) : (
                      <span className="text-xs" style={{ color: '#475569' }}>No</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <Button size="sm" variant="secondary" onClick={() => setSelectedEmail(email)}>
                      View
                    </Button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Email Preview Modal */}
      <Modal
        open={!!selectedEmail}
        onClose={() => setSelectedEmail(null)}
        title={selectedEmail?.subject ?? ''}
        wide
      >
        {selectedEmail && (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-4 text-sm" style={{ color: '#94a3b8' }}>
              <span>To: <strong className="text-white">{selectedEmail.leads?.business_name}</strong></span>
              <span>Type: <strong className="text-white">{TYPE_LABELS[selectedEmail.type]}</strong></span>
              {selectedEmail.sent_at && <span>Sent: <strong className="text-white">{formatDate(selectedEmail.sent_at)}</strong></span>}
            </div>
            <div
              className="rounded-lg p-4 text-sm max-h-96 overflow-y-auto"
              style={{ background: '#0f1117', border: '1px solid #2a2d3e', color: '#e2e8f0' }}
              dangerouslySetInnerHTML={{ __html: selectedEmail.body_html }}
            />
          </div>
        )}
      </Modal>
    </div>
  )
}
