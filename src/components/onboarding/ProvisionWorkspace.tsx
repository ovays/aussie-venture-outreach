'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

export function ProvisionWorkspace() {
  const router = useRouter()
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let active = true
    async function provision() {
      setError('')
      try {
        const response = await fetch('/api/workspace/provision', { method: 'POST' })
        const body = await response.json()
        if (!response.ok) throw new Error(body.error ?? 'Unable to create your workspace')
        if (active) { router.replace(body.data.destination); router.refresh() }
      } catch (cause) { if (active) setError(cause instanceof Error ? cause.message : 'Unable to create your workspace') }
    }
    void provision()
    return () => { active = false }
  }, [attempt, router])
  return <div className="w-full rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-8 shadow-sm"><h1 className="text-2xl font-semibold text-[var(--text-primary)]">Preparing your workspace</h1><p className="mt-3 text-sm leading-6 text-[var(--text-secondary)]">We’re creating a private ReachAgent workspace for your business.</p>{error ? <div className="mt-5"><p role="alert" className="text-sm text-[var(--error)]">{error}</p><button onClick={() => setAttempt((value) => value + 1)} className="mt-4 rounded-lg bg-[var(--primary)] px-4 py-2 text-sm font-semibold text-white">Try again</button></div> : <p className="mt-5 text-sm text-[var(--text-muted)]">This usually takes a moment…</p>}</div>
}
