import { NextRequest, NextResponse } from 'next/server'
import {
  buildEmailReportActivityRows,
  completeEmailReport,
  EmailReportValidationError,
  fetchEmailReportLeads,
  parseEmailReportDateRange,
} from '@/lib/email-report'
import { fetchHostingerReportMessages } from '@/lib/hostinger-mail'
import { logger } from '@/lib/logger'
import { createClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

export async function GET(request: NextRequest): Promise<NextResponse> {
  let range
  try {
    range = parseEmailReportDateRange(
      request.nextUrl.searchParams.get('from'),
      request.nextUrl.searchParams.get('to'),
    )
  } catch (error) {
    if (error instanceof EmailReportValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 })
    }
    throw error
  }

  let mailbox
  try {
    mailbox = await fetchHostingerReportMessages(range)
  } catch (error) {
    logger.error('email-report', 'Failed to load Hostinger mailbox metadata', {
      error: error instanceof Error ? error.message : String(error),
    })
    return NextResponse.json(
      { error: 'Unable to load email activity from Hostinger Mail' },
      { status: 502 },
    )
  }

  const activityRows = buildEmailReportActivityRows(mailbox)

  try {
    const supabase = await createClient()
    const leads = await fetchEmailReportLeads(supabase, activityRows.flatMap((row) => row.email_addresses))
    return NextResponse.json(completeEmailReport(range, activityRows, leads))
  } catch (error) {
    logger.error('email-report', 'Failed to match current ReachAgent leads', {
      error: error instanceof Error ? error.message : String(error),
    })
    return NextResponse.json(
      { error: 'Unable to match current ReachAgent lead statuses' },
      { status: 500 },
    )
  }
}
