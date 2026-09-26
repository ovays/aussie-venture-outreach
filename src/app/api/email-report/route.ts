import { NextRequest, NextResponse } from 'next/server'
import {
  buildProviderEmailReportActivityRows,
  completeEmailReport,
  EmailReportValidationError,
  fetchEmailReportLeads,
  parseEmailReportDateRange,
} from '@/lib/email-report'
import { isHostingerMailboxConfigured } from '@/lib/hostinger-mail'
import { logger } from '@/lib/logger'
import { isApiWorkspaceError, requireApiWorkspaceUser } from '@/lib/api-workspace'
import { ensureFreshAccessToken, getUsableMailboxConnection, listMailboxConnections } from '@/lib/mailbox/connections'
import { getMailboxProvider } from '@/lib/mailbox/registry'

export const runtime = 'nodejs'

export async function GET(request: NextRequest): Promise<NextResponse> {
  const context = await requireApiWorkspaceUser()
  if (isApiWorkspaceError(context)) return context
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

  let connection = null
  let provider = null
  let mailboxAddress = ''
  try {
    const requested = request.nextUrl.searchParams.get('mailbox')
    if (requested === 'env:hostinger') {
      if (process.env.HOSTINGER_WORKSPACE_ID !== context.workspace.workspaceId || !isHostingerMailboxConfigured()) throw new Error('Hostinger mailbox is not available in this workspace')
      provider = getMailboxProvider('hostinger')
      mailboxAddress = process.env.HOSTINGER_MAILBOX_ADDRESS!
    } else {
      const candidate = requested
        ? await getUsableMailboxConnection(context.supabase, requested)
        : (await listMailboxConnections(context.supabase)).find((row) => row.status === 'connected' && (row.capabilities.canReadInbox || row.capabilities.canReadSent)) ?? null
      if (!candidate) {
        if (process.env.HOSTINGER_WORKSPACE_ID === context.workspace.workspaceId && isHostingerMailboxConfigured()) {
          provider = getMailboxProvider('hostinger'); mailboxAddress = process.env.HOSTINGER_MAILBOX_ADDRESS!
        } else throw new Error('No readable mailbox is connected')
      } else {
        connection = requested ? candidate : await ensureFreshAccessToken(context.supabase, candidate)
        provider = getMailboxProvider(connection.provider)
        mailboxAddress = connection.email_address
      }
    }
    if (!provider.listMessages) throw new Error('Selected provider does not support mailbox reporting')
    const messages = await provider.listMessages(connection, range)
    const activityRows = buildProviderEmailReportActivityRows(messages, mailboxAddress)
    const leads = await fetchEmailReportLeads(context.supabase, activityRows)
    return NextResponse.json({ ...completeEmailReport(range, activityRows, leads), mailbox: { id: connection?.id ?? 'env:hostinger', email_address: mailboxAddress, provider: provider.type } })
  } catch (error) {
    logger.error('email-report', 'Failed to load mailbox metadata', {
      error: error instanceof Error ? error.message : String(error),
      workspace_id: context.workspace.workspaceId,
      mailbox_connection_id: connection?.id ?? null,
      provider: provider?.type ?? null,
    })
    return NextResponse.json(
      { error: 'Unable to load email activity from the selected mailbox' },
      { status: 502 },
    )
  }
}
