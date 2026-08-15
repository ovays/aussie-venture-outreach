import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'

interface HealthIssue {
  type: string
  message: string
  severity: 'critical' | 'warning'
  time?: string
}

interface HealthSummary {
  system_active: string | null
  last_pipeline_run: string | null
  outscraper_error: boolean
  bounce_count: number
  cost_guard: { created_at: string; metadata: { limit?: number } | null } | null
  agent_errors: Array<{ description: string; metadata: { agent?: string; error?: string; is_balance_error?: boolean } | null; created_at: string }>
  dead_letter_count: number
}

function relativeTime(isoString: string, asOf: Date): string {
  const mins = Math.floor((asOf.getTime() - new Date(isoString).getTime()) / 60_000)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

export async function GET() {
  const asOf = new Date()
  const supabase = createServiceClient()
  const { data, error } = await supabase.rpc('get_health_summary', { p_as_of: asOf.toISOString() })

  if (error || !data) {
    return NextResponse.json({
      healthy: false,
      issues: [{ type: 'database', message: `Database connection error${error?.message ? `: ${error.message}` : ''}`, severity: 'critical' }],
      checkedAt: asOf.toISOString(),
    })
  }

  const summary = data as HealthSummary
  const issues: HealthIssue[] = []
  if (summary.system_active === 'false') issues.push({ type: 'system_inactive', message: 'System is paused — pipeline will not run automatically. Enable System Active in Settings to resume.', severity: 'warning' })

  if (!summary.last_pipeline_run) {
    issues.push({ type: 'pipeline', message: 'Pipeline has never run', severity: 'warning' })
  } else {
    const hoursSince = (asOf.getTime() - new Date(summary.last_pipeline_run).getTime()) / 3_600_000
    if (hoursSince > 25) issues.push({ type: 'pipeline', message: `Pipeline has not run in ${Math.round(hoursSince)} hours`, severity: 'warning' })
  }

  if (summary.outscraper_error) issues.push({ type: 'outscraper', message: 'Outscraper balance exhausted — top up at outscraper.com', severity: 'critical' })
  if (summary.bounce_count > 0) issues.push({ type: 'resend', message: `${summary.bounce_count} email bounce${summary.bounce_count === 1 ? '' : 's'} detected in last 24 hours`, severity: 'warning' })

  if (summary.cost_guard) {
    issues.push({
      type: 'cost_guard',
      message: `Daily Outscraper limit $${summary.cost_guard.metadata?.limit ?? '?'} reached — pipeline stopped to prevent overspending. Adjust limit in Settings or wait until tomorrow.`,
      severity: 'critical',
      time: relativeTime(summary.cost_guard.created_at, asOf),
    })
  }

  for (const agentError of summary.agent_errors ?? []) {
    const agent = agentError.metadata?.agent ?? 'unknown'
    const errorMessage = (agentError.metadata?.error ?? agentError.description ?? '').slice(0, 120)
    const isBalance = agentError.metadata?.is_balance_error ?? errorMessage.includes('402')
    issues.push({
      type: `agent_error_${agent}`,
      message: isBalance ? `${agent} agent: Outscraper balance exhausted — top up at outscraper.com` : `${agent} agent failed: ${errorMessage}`,
      severity: 'critical',
      time: relativeTime(agentError.created_at, asOf),
    })
  }

  if (summary.dead_letter_count > 0) issues.push({ type: 'dead_letter', message: `${summary.dead_letter_count} failed operation${summary.dead_letter_count === 1 ? '' : 's'} in dead-letter queue — review in Settings`, severity: 'warning' })

  return NextResponse.json({ healthy: issues.length === 0, issues, checkedAt: asOf.toISOString() })
}
