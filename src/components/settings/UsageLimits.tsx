'use client'

import { useEffect, useState } from 'react'
import type { WorkspaceUsageOverview } from '@/lib/quota/service'
import type { QuotaDimension } from '@/lib/quota/dimensions'

const LABELS: Record<QuotaDimension, string> = {
  outbound_email: 'Outbound emails',
  ai_request: 'AI requests',
  discovery_request: 'Discovery requests',
  workspace_member: 'Workspace members',
  mailbox_connection: 'Mailbox connections',
  stored_lead: 'Stored leads',
}

export function UsageLimits() {
  const [usage, setUsage] = useState<WorkspaceUsageOverview | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    fetch('/api/usage', { cache: 'no-store' })
      .then(async (response) => {
        const body = await response.json()
        if (!response.ok) throw new Error(body.error ?? 'Unable to load usage')
        if (active) setUsage(body.data)
      })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : String(reason)) })
    return () => { active = false }
  }, [])

  return (
    <div id="usage" className="scroll-mt-28 space-y-4">
      <div>
        <h2 className="text-base font-semibold text-[var(--text-primary)]">Usage &amp; Limits</h2>
        <p className="mt-1 text-sm text-[var(--text-muted)]">
          Current workspace entitlement and monthly usage. Counts update when an operation reserves quota.
        </p>
      </div>
      {error && <p className="text-sm text-red-400">{error}</p>}
      {!usage && !error && <p className="text-sm text-[var(--text-muted)]">Loading usage…</p>}
      {usage && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--border)] bg-[var(--background-subtle)] px-4 py-3">
            <span className="text-sm text-[var(--text-secondary)]">Entitlement</span>
            <span className="text-sm font-medium text-[var(--text-primary)]">{usage.planName ?? 'Not assigned'}</span>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {(Object.entries(usage.dimensions) as Array<[QuotaDimension, WorkspaceUsageOverview['dimensions'][QuotaDimension]]>).map(([key, item]) => {
              const percent = item.limit && item.limit > 0 ? Math.min(100, (item.used / item.limit) * 100) : 0
              return (
                <div key={key} className="rounded-lg border border-[var(--border)] p-4">
                  <div className="flex items-center justify-between gap-3 text-sm">
                    <span className="font-medium text-[var(--text-primary)]">{LABELS[key]}</span>
                    <span className="text-[var(--text-muted)]">{item.used} / {item.limit === null ? 'Unlimited' : item.limit}</span>
                  </div>
                  {item.limit !== null && (
                    <div className="mt-3 h-2 overflow-hidden rounded-full bg-[var(--background-subtle)]">
                      <div className="h-full rounded-full bg-sky-500" style={{ width: `${percent}%` }} />
                    </div>
                  )}
                </div>
              )
            })}
          </div>
          {usage.periodStart && usage.periodEnd && (
            <p className="text-xs text-[var(--text-muted)]">
              Monthly period: {new Date(usage.periodStart).toLocaleDateString()} – {new Date(usage.periodEnd).toLocaleDateString()}
            </p>
          )}
        </>
      )}
    </div>
  )
}
