'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/Button'
import type { BillingSummary } from '@/lib/billing/types'

export function BillingSettings({ canManage }: { canManage: boolean }) {
  const [billing, setBilling] = useState<BillingSummary | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    fetch('/api/billing', { cache: 'no-store' })
      .then(async (response) => {
        const body = await response.json()
        if (!response.ok) throw new Error(body.error ?? 'Unable to load billing')
        setBilling(body.data)
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))
  }, [])

  async function openSession(path: string, payload?: object) {
    setBusy(true); setError('')
    try {
      const response = await fetch(path, {
        method: 'POST', headers: payload ? { 'Content-Type': 'application/json' } : undefined,
        body: payload ? JSON.stringify(payload) : undefined,
      })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error ?? 'Unable to start billing session')
      window.location.assign(body.data.url)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason)); setBusy(false)
    }
  }

  return (
    <div id="billing" className="scroll-mt-28 space-y-4">
      <div>
        <h2 className="text-base font-semibold text-[var(--text-primary)]">Billing</h2>
        <p className="mt-1 text-sm text-[var(--text-muted)]">Subscription status selects the base entitlement; Usage &amp; Limits enforces it.</p>
      </div>
      {error && <p className="text-sm text-red-400">{error}</p>}
      {!billing && !error && <p className="text-sm text-[var(--text-muted)]">Loading billing…</p>}
      {billing && (
        <>
          <div className="grid grid-cols-1 gap-3 rounded-lg border border-[var(--border)] bg-[var(--background-subtle)] p-4 text-sm sm:grid-cols-3">
            <div><p className="text-[var(--text-muted)]">Plan</p><p className="mt-1 font-medium">{billing.planName}</p></div>
            <div><p className="text-[var(--text-muted)]">Status</p><p className="mt-1 font-medium">{billing.managedInternally ? 'Managed internally' : billing.subscriptionStatus.replaceAll('_', ' ')}</p></div>
            <div><p className="text-[var(--text-muted)]">Current period</p><p className="mt-1 font-medium">{billing.currentPeriodEnd ? `${billing.cancelAtPeriodEnd ? 'Ends' : 'Renews'} ${new Date(billing.currentPeriodEnd).toLocaleDateString()}` : '—'}</p></div>
          </div>
          {canManage && !billing.managedInternally && (
            <div className="flex flex-wrap gap-2">
              {billing.hasStripeCustomer && <Button disabled={busy} variant="secondary" onClick={() => void openSession('/api/billing/portal')}>Manage Billing</Button>}
              {billing.availablePlans.map((plan) => (
                <Button key={plan.code} disabled={busy} onClick={() => void openSession('/api/billing/checkout', { planCode: plan.code })}>
                  Choose {plan.name}
                </Button>
              ))}
            </div>
          )}
          {!billing.managedInternally && billing.availablePlans.length === 0 && (
            <p className="text-xs text-[var(--text-muted)]">Plan selection is not configured yet. No prices are shown or inferred.</p>
          )}
          <a className="text-sm text-sky-400 hover:underline" href="#usage">View Usage &amp; Limits</a>
        </>
      )}
    </div>
  )
}
