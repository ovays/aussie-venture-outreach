import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'

interface HealthIssue {
  type: string
  message: string
}

export async function GET() {
  const issues: HealthIssue[] = []
  const supabase = createServiceClient()

  // 1. Supabase connection
  try {
    const { error } = await supabase.from('leads').select('id').limit(1)
    if (error) issues.push({ type: 'database', message: `Database connection error: ${error.message}` })
  } catch {
    issues.push({ type: 'database', message: 'Database connection error' })
  }

  // 2. Last pipeline run — warn if no finder_complete in 25 hours
  try {
    const { data } = await supabase
      .from('activity_log')
      .select('created_at')
      .eq('event_type', 'finder_complete')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (!data) {
      issues.push({ type: 'pipeline', message: 'Pipeline has never run' })
    } else {
      const hoursSince = (Date.now() - new Date(data.created_at).getTime()) / 3_600_000
      if (hoursSince > 25) {
        issues.push({ type: 'pipeline', message: `Pipeline has not run in ${Math.round(hoursSince)} hours` })
      }
    }
  } catch {
    // non-critical — skip if activity_log inaccessible
  }

  // 3. Outscraper 402 / quota errors in last 24h
  try {
    const since24h = new Date(Date.now() - 24 * 3_600_000).toISOString()
    const { data } = await supabase
      .from('activity_log')
      .select('id')
      .gte('created_at', since24h)
      .or('description.ilike.%402%,description.ilike.%quota exhausted%,description.ilike.%balance%')
      .limit(1)

    if (data?.length) {
      issues.push({ type: 'outscraper', message: 'Outscraper balance exhausted — top up at outscraper.com' })
    }
  } catch {
    // skip
  }

  // 4. Resend bounces in last 24h
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
