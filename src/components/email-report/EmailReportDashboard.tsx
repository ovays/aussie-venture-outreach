'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Download, Search } from 'lucide-react'
import type { EmailReportResponse, EmailReportRow, EmailReportStatus } from '@/lib/email-report'
import {
  emailStatusLabel,
  filterEmailReportRows,
  formatSydneyTimestamp,
  generateEmailReportCsv,
  getEmailReportPresetRange,
  reachAgentStatusLabel,
  type EmailReportPreset,
  validateEmailReportUiRange,
} from '@/lib/email-report-ui'
import { useLeadDrawer } from '@/lib/lead-drawer-context'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { StatusBadge } from '@/components/ui/Badge'
import { EmailAddressList } from '@/components/email-report/EmailAddressList'

const PRESETS: Array<{ value: EmailReportPreset; label: string }> = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'last_7_days', label: 'Last 7 Days' },
  { value: 'last_30_days', label: 'Last 30 Days' },
  { value: 'this_month', label: 'This Month' },
]

const EMAIL_STATUS_STYLES: Record<EmailReportStatus, string> = {
  replied: 'bg-green-500/20 text-green-400',
  awaiting_reply: 'bg-amber-500/20 text-amber-300',
  sent_only: 'bg-sky-500/20 text-sky-300',
}

function EmailStatusBadge({ status }: { status: EmailReportStatus }) {
  return (
    <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${EMAIL_STATUS_STYLES[status]}`}>
      {emailStatusLabel(status)}
    </span>
  )
}

function errorMessageForStatus(status: number, apiMessage?: string): string {
  if (status === 400) return apiMessage || 'Choose a valid date range of no more than 366 days.'
  if (status === 401 || status === 403) return 'Your session has expired or you do not have access. Please sign in again.'
  if (status === 502) return 'Unable to load email activity from Hostinger Mail. Please try again.'
  return 'Unable to load the email report. Please try again.'
}

export function EmailReportDashboard() {
  const initialRange = useMemo(() => getEmailReportPresetRange('last_30_days'), [])
  const [from, setFrom] = useState(initialRange.from)
  const [to, setTo] = useState(initialRange.to)
  const [appliedRange, setAppliedRange] = useState(initialRange)
  const [report, setReport] = useState<EmailReportResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [validation, setValidation] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [emailStatus, setEmailStatus] = useState('')
  const [reachagentStatus, setReachagentStatus] = useState('')
  const requestSequence = useRef(0)
  const { openDrawer } = useLeadDrawer()

  const loadReport = useCallback(async (signal: AbortSignal, sequence: number) => {
    setLoading(true)
    setError(null)
    const params = new URLSearchParams({ from: appliedRange.from, to: appliedRange.to })
    try {
      const response = await fetch(`/api/email-report?${params.toString()}`, { signal, method: 'GET' })
      const json = await response.json() as EmailReportResponse & { error?: string }
      if (!response.ok) throw Object.assign(new Error(json.error), { status: response.status, apiMessage: json.error })
      if (sequence === requestSequence.current) setReport(json)
    } catch (requestError) {
      if (requestError instanceof DOMException && requestError.name === 'AbortError') return
      if (sequence !== requestSequence.current) return
      const details = requestError as Error & { status?: number; apiMessage?: string }
      setError(errorMessageForStatus(details.status ?? 0, details.apiMessage))
      setReport(null)
    } finally {
      if (sequence === requestSequence.current) setLoading(false)
    }
  }, [appliedRange])

  useEffect(() => {
    const controller = new AbortController()
    const sequence = ++requestSequence.current
    void loadReport(controller.signal, sequence)
    return () => controller.abort()
  }, [loadReport])

  const reachagentStatuses = useMemo(() => Object.keys(report?.summary.reachagent_status_counts ?? {})
    .sort((a, b) => reachAgentStatusLabel(a).localeCompare(reachAgentStatusLabel(b))), [report])

  const filteredRows = useMemo(() => filterEmailReportRows(
    report?.rows ?? [], search, emailStatus, reachagentStatus,
  ), [report, search, emailStatus, reachagentStatus])

  function applyRange() {
    const next = { from, to }
    const message = validateEmailReportUiRange(next)
    setValidation(message)
    if (!message) setAppliedRange((current) => current.from === next.from && current.to === next.to ? current : next)
  }

  function applyPreset(preset: EmailReportPreset) {
    const next = getEmailReportPresetRange(preset)
    setFrom(next.from)
    setTo(next.to)
    setValidation(null)
    setAppliedRange((current) => current.from === next.from && current.to === next.to ? current : next)
  }

  function exportCsv() {
    const csv = generateEmailReportCsv(filteredRows)
    const url = URL.createObjectURL(new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `email-report-${appliedRange.from}-to-${appliedRange.to}.csv`
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="space-y-5" data-testid="email-report-page">
      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-40 flex-1 sm:flex-none">
            <Input label="From date" type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
          </div>
          <div className="min-w-40 flex-1 sm:flex-none">
            <Input label="To date" type="date" value={to} onChange={(event) => setTo(event.target.value)} />
          </div>
          <Button onClick={applyRange}>Apply</Button>
          <span className="pb-2 text-xs" style={{ color: '#64748b' }}>Australia/Sydney time</span>
        </div>
        <div className="mt-3 flex flex-wrap gap-2" aria-label="Date presets">
          {PRESETS.map((preset) => (
            <Button key={preset.value} size="sm" variant="secondary" onClick={() => applyPreset(preset.value)}>
              {preset.label}
            </Button>
          ))}
        </div>
        {validation && <p className="mt-3 text-sm text-red-400" role="alert">{validation}</p>}
      </Card>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { label: 'Unique Businesses', value: report?.summary.unique_contacts ?? 0, color: '#38bdf8' },
          { label: 'Replied', value: report?.summary.replied ?? 0, color: '#4ade80' },
          { label: 'Awaiting Reply', value: report?.summary.awaiting_reply ?? 0, color: '#fbbf24' },
          { label: 'Sent Only', value: report?.summary.sent_only ?? 0, color: '#a78bfa' },
        ].map((item) => (
          <Card key={item.label} className="!p-4">
            <p className="text-xs" style={{ color: '#64748b' }}>{item.label}</p>
            <p className="mt-1 text-2xl font-bold" style={{ color: item.color }}>{loading ? '—' : item.value}</p>
          </Card>
        ))}
      </div>

      {report && reachagentStatuses.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-xs" style={{ color: '#64748b' }}>
          <span>ReachAgent statuses:</span>
          {reachagentStatuses.map((status) => (
            <span key={status} className="rounded-full px-2.5 py-1" style={{ background: '#1e2130', border: '1px solid #2a2d3e', color: '#94a3b8' }}>
              {reachAgentStatusLabel(status)}: {report.summary.reachagent_status_counts[status]}
            </span>
          ))}
        </div>
      )}

      <Card noPadding className="overflow-hidden">
        <div className="flex flex-wrap gap-3 border-b p-4" style={{ borderColor: '#2a2d3e' }}>
          <div className="relative min-w-56 flex-1">
            <Search className="pointer-events-none absolute left-3 top-2.5" size={15} color="#64748b" />
            <input
              aria-label="Search business or email"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search business or email"
              className="w-full rounded-lg py-2 pl-9 pr-3 text-sm text-white outline-none focus:ring-2 focus:ring-sky-500"
              style={{ background: '#0f1117', border: '1px solid #2a2d3e' }}
            />
          </div>
          <Select
            aria-label="Email Status"
            value={emailStatus}
            onChange={(event) => setEmailStatus(event.target.value)}
            className="min-w-44"
            options={[
              { value: '', label: 'All Email Statuses' },
              { value: 'replied', label: 'Replied' },
              { value: 'awaiting_reply', label: 'Awaiting Reply' },
              { value: 'sent_only', label: 'Sent Only' },
            ]}
          />
          <Select
            aria-label="ReachAgent Status"
            value={reachagentStatus}
            onChange={(event) => setReachagentStatus(event.target.value)}
            className="min-w-48"
            options={[
              { value: '', label: 'All ReachAgent Statuses' },
              ...reachagentStatuses.map((status) => ({ value: status, label: reachAgentStatusLabel(status) })),
            ]}
          />
          <Button
            size="sm"
            variant="secondary"
            disabled={loading || !report || filteredRows.length === 0}
            onClick={exportCsv}
          >
            <Download size={15} />
            Export CSV
          </Button>
          <span className="self-center text-xs" style={{ color: '#64748b' }}>
            {filteredRows.length} business{filteredRows.length === 1 ? '' : 'es'}
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[940px] text-sm">
            <thead>
              <tr style={{ borderBottom: '1px solid #2a2d3e' }}>
                {['Business', 'Email', 'ReachAgent Status', 'Received', 'Sent', 'Email Status', 'Last Activity', 'Last Direction'].map((label) => (
                  <th key={label} className="whitespace-nowrap px-4 py-3 text-left text-xs font-medium uppercase tracking-wider" style={{ color: '#64748b' }}>{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? <LoadingRows />
                : error ? <MessageRow message={error} tone="error" />
                  : !report || report.rows.length === 0 ? <MessageRow message="No email activity found for this date range." />
                    : filteredRows.length === 0 ? <MessageRow message="No contacts match the current filters." />
                      : filteredRows.map((row) => <ReportRow key={row.email} row={row} openLead={openDrawer} />)}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}

function LoadingRows() {
  return <>{[0, 1, 2, 3].map((index) => (
    <tr key={index} className="border-b" style={{ borderColor: '#1e2130' }}>
      <td colSpan={8} className="px-4 py-4"><div className="h-5 animate-pulse rounded" style={{ background: '#2a2d3e', width: `${88 - index * 8}%` }} /></td>
    </tr>
  ))}</>
}

function MessageRow({ message, tone = 'muted' }: { message: string; tone?: 'muted' | 'error' }) {
  return <tr><td colSpan={8} className={`px-4 py-14 text-center ${tone === 'error' ? 'text-red-400' : ''}`} style={tone === 'muted' ? { color: '#64748b' } : undefined}>{message}</td></tr>
}

function ReportRow({ row, openLead }: { row: EmailReportRow; openLead: (leadId: string) => void }) {
  const business = row.business_name || '—'
  const addresses = row.email_addresses?.length ? row.email_addresses : [row.email]
  const [addressesExpanded, setAddressesExpanded] = useState(false)
  return (
    <tr className="border-b last:border-b-0" style={{ borderColor: '#1e2130' }}>
      <td className="max-w-52 px-4 py-3 font-medium text-white">
        {row.lead_id
          ? <button className="text-left text-sky-400 hover:text-sky-300 hover:underline" onClick={() => openLead(row.lead_id!)}>{business}</button>
          : business}
      </td>
      <td className="max-w-60 px-4 py-3">
        <EmailAddressList
          addresses={addresses}
          expanded={addressesExpanded}
          onToggle={() => setAddressesExpanded((current) => !current)}
        />
      </td>
      <td className="px-4 py-3">
        {row.reachagent_status === 'not_found' || row.reachagent_status === 'ambiguous'
          ? <span className="inline-flex rounded-full bg-gray-500/20 px-2.5 py-1 text-xs font-medium text-gray-300">{reachAgentStatusLabel(row.reachagent_status, row.matching_lead_count)}</span>
          : <StatusBadge status={row.reachagent_status} />}
      </td>
      <td className="px-4 py-3 text-center tabular-nums" style={{ color: '#cbd5e1' }}>{row.received_count}</td>
      <td className="px-4 py-3 text-center tabular-nums" style={{ color: '#cbd5e1' }}>{row.sent_count}</td>
      <td className="px-4 py-3"><EmailStatusBadge status={row.email_status} /></td>
      <td className="whitespace-nowrap px-4 py-3 text-xs" style={{ color: '#94a3b8' }}>{formatSydneyTimestamp(row.last_activity_at)}</td>
      <td className="px-4 py-3 capitalize" style={{ color: '#94a3b8' }}>{row.last_direction}</td>
    </tr>
  )
}
