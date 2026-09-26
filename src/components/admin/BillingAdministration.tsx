'use client'

import { useEffect, useState } from 'react'

type Row = {
  id: string
  name: string
  entitlementPlanCode: string
  billing: {
    stripe_customer_id: string | null; stripe_subscription_id: string | null; stripe_price_id: string | null
    plan_code: string | null; subscription_status: string; current_period_end: string | null
    sync_status: string; last_sync_error: string | null
  } | null
}

function shortId(value: string | null | undefined) {
  return value ? `${value.slice(0, 12)}…` : '—'
}

export function BillingAdministration() {
  const [rows, setRows] = useState<Row[]>([])
  const [error, setError] = useState('')
  useEffect(() => {
    fetch('/api/admin/billing', { cache: 'no-store' }).then(async (response) => {
      const body = await response.json()
      if (!response.ok) throw new Error(body.error ?? 'Unable to load billing')
      setRows(body.data)
    }).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))
  }, [])
  return <div className="space-y-4">
    <div><h2 className="text-base font-semibold">Workspace billing</h2><p className="mt-1 text-sm text-[var(--text-muted)]">Stripe mapping and entitlement synchronization state.</p></div>
    {error && <p className="text-sm text-red-400">{error}</p>}
    <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="border-b border-[var(--border)] text-[var(--text-muted)]">
      <th className="p-2">Workspace</th><th className="p-2">Entitlement / plan</th><th className="p-2">Customer / subscription</th><th className="p-2">Status</th><th className="p-2">Price mapping</th><th className="p-2">Period end / sync</th>
    </tr></thead><tbody>{rows.map((row) => {
      const billing = row.billing
      const entitlement = row.entitlementPlanCode
      return <tr key={row.id} className="border-b border-[var(--border)] align-top">
        <td className="p-2 font-medium">{row.name}</td><td className="p-2">{entitlement} / {billing?.plan_code ?? 'none'}</td>
        <td className="p-2" title={`${billing?.stripe_customer_id ?? ''} ${billing?.stripe_subscription_id ?? ''}`}>{shortId(billing?.stripe_customer_id)} / {shortId(billing?.stripe_subscription_id)}</td>
        <td className="p-2">{billing?.subscription_status ?? 'none'}</td><td className="p-2" title={billing?.stripe_price_id ?? ''}>{shortId(billing?.stripe_price_id)}</td>
        <td className="p-2">{billing?.current_period_end ? new Date(billing.current_period_end).toLocaleDateString() : '—'} / {billing?.sync_status ?? 'not configured'}{billing?.last_sync_error ? <p className="text-xs text-red-400">{billing.last_sync_error}</p> : null}</td>
      </tr>
    })}</tbody></table></div>
  </div>
}
