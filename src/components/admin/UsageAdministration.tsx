'use client'

import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { QUOTA_DIMENSIONS, type QuotaDimension } from '@/lib/quota/dimensions'

interface WorkspaceRow {
  id: string
  name: string
  slug: string
  status: string
  planCode: string | null
  planName: string | null
}

interface Detail {
  usage: {
    planCode: string | null
    planName: string | null
    dimensions: Record<QuotaDimension, { used: number; limit: number | null }>
  }
  overrides: Array<{ dimensionKey: string; limitValue: number | null; notes: string | null }>
}

const LABELS: Record<QuotaDimension, string> = {
  outbound_email: 'Outbound emails', ai_request: 'AI requests', discovery_request: 'Discovery requests',
  workspace_member: 'Workspace members', mailbox_connection: 'Mailbox connections', stored_lead: 'Stored leads',
}

export function UsageAdministration() {
  const [workspaces, setWorkspaces] = useState<WorkspaceRow[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [detail, setDetail] = useState<Detail | null>(null)
  const [dimension, setDimension] = useState<QuotaDimension>('outbound_email')
  const [limit, setLimit] = useState('')
  const [notes, setNotes] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const selected = useMemo(() => workspaces.find((workspace) => workspace.id === selectedId), [selectedId, workspaces])

  async function loadDetail(workspaceId: string) {
    if (!workspaceId) { setDetail(null); return }
    const response = await fetch(`/api/admin/usage?workspaceId=${encodeURIComponent(workspaceId)}`, { cache: 'no-store' })
    const body = await response.json()
    if (!response.ok) throw new Error(body.error ?? 'Unable to load workspace usage')
    setDetail(body.data)
  }

  useEffect(() => {
    fetch('/api/admin/usage', { cache: 'no-store' })
      .then(async (response) => {
        const body = await response.json()
        if (!response.ok) throw new Error(body.error ?? 'Unable to load workspaces')
        setWorkspaces(body.data)
        if (body.data[0]) setSelectedId(body.data[0].id)
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))
  }, [])

  useEffect(() => { loadDetail(selectedId).catch((reason) => setError(reason.message)) }, [selectedId])

  async function mutate(payload: Record<string, unknown>) {
    setBusy(true); setError('')
    try {
      const response = await fetch('/api/admin/usage', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error ?? 'Unable to update quota')
      await loadDetail(selectedId)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally { setBusy(false) }
  }

  function saveOverride() {
    const parsedLimit = limit === '' ? null : Number(limit)
    if (parsedLimit !== null && (!Number.isInteger(parsedLimit) || parsedLimit < 0)) {
      setError('Limit must be a non-negative whole number, or blank for unlimited.')
      return
    }
    void mutate({ action: 'set_override', workspaceId: selectedId, dimension, limit: parsedLimit, notes })
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-base font-semibold text-[var(--text-primary)]">Workspace entitlements &amp; usage</h2>
        <p className="mt-1 text-sm text-[var(--text-muted)]">Platform-admin visibility and auditable per-workspace limit overrides.</p>
      </div>
      <select
        value={selectedId}
        onChange={(event) => setSelectedId(event.target.value)}
        className="w-full rounded-lg border border-[var(--border)] bg-[var(--background-subtle)] px-3 py-2 text-sm text-[var(--text-primary)]"
      >
        {workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name} — {workspace.planName ?? 'No entitlement'}</option>)}
      </select>
      {error && <p className="text-sm text-red-400">{error}</p>}
      {selected && detail && (
        <>
          <div className="rounded-lg border border-[var(--border)] bg-[var(--background-subtle)] p-4 text-sm">
            <span className="text-[var(--text-muted)]">Current entitlement: </span>
            <span className="font-medium text-[var(--text-primary)]">{detail.usage.planName ?? 'Not assigned'} ({detail.usage.planCode ?? 'none'})</span>
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {QUOTA_DIMENSIONS.map((key) => {
              const item = detail.usage.dimensions[key]
              const override = detail.overrides.find((row) => row.dimensionKey === key)
              return <div key={key} className="rounded-lg border border-[var(--border)] p-3 text-sm">
                <div className="flex justify-between gap-3"><span>{LABELS[key]}</span><span>{item.used} / {item.limit ?? 'Unlimited'}</span></div>
                {override && <p className="mt-1 text-xs text-amber-300">Override: {override.limitValue ?? 'Unlimited'}{override.notes ? ` — ${override.notes}` : ''}</p>}
              </div>
            })}
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
            <select value={dimension} onChange={(event) => setDimension(event.target.value as QuotaDimension)} className="rounded-lg border border-[var(--border)] bg-[var(--background-subtle)] px-3 py-2 text-sm">
              {QUOTA_DIMENSIONS.map((key) => <option key={key} value={key}>{LABELS[key]}</option>)}
            </select>
            <Input value={limit} onChange={(event) => setLimit(event.target.value)} inputMode="numeric" placeholder="Limit (blank = unlimited)" />
            <Input value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Reason / notes" />
            <div className="flex gap-2">
              <Button disabled={busy} onClick={saveOverride}>Save</Button>
              <Button variant="secondary" disabled={busy} onClick={() => mutate({ action: 'clear_override', workspaceId: selectedId, dimension })}>Clear</Button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
