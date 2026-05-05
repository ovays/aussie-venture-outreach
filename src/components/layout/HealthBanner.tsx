'use client'

import { useState, useEffect, useCallback } from 'react'
import { AlertTriangle, AlertCircle, X, ExternalLink } from 'lucide-react'

interface HealthIssue {
  type: string
  message: string
  severity?: 'critical' | 'warning'
  time?: string
}

interface HealthResponse {
  healthy: boolean
  issues: HealthIssue[]
}

const TRIGGER_URL = 'https://cloud.trigger.dev/orgs/aussie-venture-0008/projects/aussie-venture-outreach-iBCD/runs'

function isCritical(issue: HealthIssue): boolean {
  if (issue.severity === 'critical') return true
  if (issue.severity === 'warning') return false
  return issue.type.startsWith('agent_error') || issue.type === 'outscraper' || issue.type === 'database'
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
        setDismissed(new Set())
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
      {visible.map((issue) => {
        const critical = isCritical(issue)
        const isAgentError = issue.type.startsWith('agent_error')
        return (
          <div
            key={issue.type}
            className="flex items-start gap-3 px-4 py-2.5"
            style={{
              background: critical ? '#450a0a' : '#431407',
              borderBottom: `1px solid ${critical ? '#7f1d1d' : '#9a3412'}`,
            }}
          >
            {critical ? (
              <AlertCircle size={14} className="shrink-0 mt-0.5" style={{ color: '#f87171' }} />
            ) : (
              <AlertTriangle size={14} className="shrink-0 mt-0.5" style={{ color: '#fb923c' }} />
            )}
            <span className="flex-1 text-sm" style={{ color: critical ? '#fca5a5' : '#fdba74' }}>
              <span className="font-semibold">
                {critical ? 'Pipeline Error' : 'Warning'}{issue.time ? ` · ${issue.time}` : ''}:{' '}
              </span>
              {issue.message}
              {isAgentError && (
                <a
                  href={TRIGGER_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ml-2 inline-flex items-center gap-1 underline hover:no-underline"
                  style={{ color: critical ? '#f87171' : '#fb923c' }}
                >
                  View logs <ExternalLink size={10} />
                </a>
              )}
            </span>
            <button
              onClick={() => setDismissed((prev) => new Set([...prev, issue.type]))}
              className="transition-colors hover:text-white shrink-0"
              style={{ color: critical ? '#f87171' : '#fb923c' }}
              aria-label="Dismiss"
            >
              <X size={14} />
            </button>
          </div>
        )
      })}
    </div>
  )
}
