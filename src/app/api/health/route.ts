import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'

interface HealthIssue {
  type: string
  message: string
  severity: 'critical' | 'warning'
  time?: string
}

function relativeTime(isoString: string): string {
  const ms = Date.now() - new Date(isoString).getTime()
  const mins = Math.floor(ms / 60_000)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

export async function GET() {
  const issues: HealthIssue[] = []
  const supabase = createServiceClient()

  // 1. Supabase connection
  try {
    const { error } = await supabase.from('leads').select('id').limit(1)
    if (error) issues.push({ type: 'database', message: `Database connection error: ${error.message}`, severity: 'critical' })
  } catch {
    issues.push({ type: 'database', message: 'Database connection error', severity: 'critical' })
  }

  // 2. System active check
  try {
    const { data: systemSetting } = await supabase
      .from('settings')
      .select('value')
      .eq('key', 'system_active')
      .single()

    if (systemSetting?.value === 'false') {
      issues.push({
        type: 'system_inactive',
        message: 'System is paused — pipeline will not run automatically. Enable System Active in Settings to resume.',
        severity: 'warning',
      })
    }
  } catch {
    // skip
  }

  // 3. Last pipeline run — warn if no finder_complete in 25 hours
  try {
    const { data } = await supabase
      .from('activity_log')
      .select('created_at')
      .eq('event_type', 'finder_complete')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (!data) {
      issues.push({ type: 'pipeline', message: 'Pipeline has never run', severity: 'warning' })
    } else {
      const hoursSince = (Date.now() - new Date(data.created_at).getTime()) / 3_600_000
      if (hoursSince > 25) {
        issues.push({ type: 'pipeline', message: `Pipeline has not run in ${Math.round(hoursSince)} hours`, severity: 'warning' })
      }
    }
  } catch {
    // non-critical — skip if activity_log inaccessible
  }

  // 4. Outscraper 402 / quota errors in last 24h
  try {
    const since24h = new Date(Date.now() - 24 * 3_600_000).toISOString()
    const { data } = await supabase
      .from('activity_log')
      .select('id')
      .gte('created_at', since24h)
      .or('description.ilike.%402%,description.ilike.%quota exhausted%,description.ilike.%balance%')
      .limit(1)

    if (data?.length) {
      issues.push({ type: 'outscraper', message: 'Outscraper balance exhausted — top up at outscraper.com', severity: 'critical' })
    }
  } catch {
    // skip
  }

  // 5. Resend bounces in last 24h
  try {
    const since24h = new Date(Date.now() - 24 * 3_600_000).toISOString()
    const { count } = await supabase
      .from('emails')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'bounced')
      .gte('sent_at', since24h)

    if ((count ?? 0) > 0) {
      issues.push({
        type: 'resend',
        message: `${count} email bounce${count === 1 ? '' : 's'} detected in last 24 hours`,
        severity: 'warning',
      })
    }
  } catch {
    // skip
  }

  // 6. Cost guard triggered in last 2 hours only — avoids stale banners from yesterday's run
  try {
    const since2h = new Date(Date.now() - 2 * 3_600_000).toISOString()
    const { data: costGuard } = await supabase
      .from('activity_log')
      .select('created_at, metadata')
      .eq('event_type', 'cost_guard_triggered')
      .gte('created_at', since2h)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (costGuard) {
      const meta = costGuard.metadata as { limit?: number } | null
      issues.push({
        type: 'cost_guard',
        message: `Daily Outscraper limit $${meta?.limit ?? '?'} reached — pipeline stopped to prevent overspending. Adjust limit in Settings or wait until tomorrow.`,
        severity: 'critical',
        time: relativeTime(costGuard.created_at),
      })
    }
  } catch {
    // skip
  }

  // 7. Recent agent errors (last 25 hours)
  try {
    const since25h = new Date(Date.now() - 25 * 3_600_000).toISOString()
    const { data: agentErrors } = await supabase
      .from('activity_log')
      .select('description, metadata, created_at')
      .eq('event_type', 'agent_error')
      .gte('created_at', since25h)
      .order('created_at', { ascending: false })
      .limit(5)

    for (const err of agentErrors ?? []) {
      const meta = err.metadata as { agent?: string; error?: string; is_balance_error?: boolean } | null
      const agent = meta?.agent ?? 'unknown'
      const errorMsg = (meta?.error ?? err.description ?? '').slice(0, 120)
      const isBalance = meta?.is_balance_error ?? errorMsg.includes('402')
      const displayMsg = isBalance
        ? `${agent} agent: Outscraper balance exhausted — top up at outscraper.com`
        : `${agent} agent failed: ${errorMsg}`
      issues.push({
        type: `agent_error_${agent}`,
        message: displayMsg,
        severity: 'critical',
        time: relativeTime(err.created_at),
      })
    }
  } catch {
    // skip
  }

  return NextResponse.json({
    healthy: issues.length === 0,
    issues,
    checkedAt: new Date().toISOString(),
  })
}
