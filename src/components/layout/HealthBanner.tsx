'use client'

import { useState, useEffect, useCallback } from 'react'
import { AlertTriangle, X } from 'lucide-react'

interface HealthIssue {
  type: string
  message: string
}

interface HealthResponse {
  healthy: boolean
  issues: HealthIssue[]
}

export function HealthBanner() {
  const [issues, setIssues] = useState<HealthIssue[]>([])
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())

  const checkHealth = useCallback(async () => {
    try {
      const res = await fetch('/api/health')
      const data: HealthResponse = await res.json()
      if (!data.healthy && data.issues.length > 0) {
        setIssues(data.issues)
        setDismissed(new Set()) // reset dismissals so new check re-shows
      } else {
        setIssues([])
      }
    } catch {
      // network error — don't surface as health issue
    }
  }, [])

  useEffect(() => {
    checkHealth()
    const interval = setInterval(checkHealth, 5 * 60 * 1000)
    return () => clearInterval(interval)
  }, [checkHealth])

  const visible = issues.filter((i) => !dismissed.has(i.type))
  if (!visible.length) return null

  return (
    <div>
      {visible.map((issue) => (
        <div
          key={issue.type}
          className="flex items-center gap-3 px-4 py-2.5"
          style={{ background: '#450a0a', borderBottom: '1px solid #7f1d1d' }}
        >
          <AlertTriangle size={14} className="shrink-0" style={{ color: '#f87171' }} />
          <span className="flex-1 text-sm" style={{ color: '#fca5a5' }}>
            <span className="font-semibold">System Issue: </span>
            {issue.message}
          </span>
          <button
            onClick={() => setDismissed((prev) => new Set([...prev, issue.type]))}
            className="transition-colors hover:text-white"
            style={{ color: '#f87171' }}
            aria-label="Dismiss"
          >
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  )
}
