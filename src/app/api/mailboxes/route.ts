import { NextResponse } from 'next/server'
import { isApiWorkspaceError, requireApiWorkspaceUser } from '@/lib/api-workspace'
import { isHostingerMailboxConfigured } from '@/lib/hostinger-mail'
import { listMailboxConnections, publicMailboxConnection } from '@/lib/mailbox/connections'
import { HOSTINGER_CAPABILITIES, RESEND_CAPABILITIES, type PublicMailboxConnection } from '@/lib/mailbox/types'

function environmentConnections(workspaceId: string): PublicMailboxConnection[] {
  const now = new Date(0).toISOString()
  const rows: PublicMailboxConnection[] = []
  if (process.env.HOSTINGER_WORKSPACE_ID === workspaceId && isHostingerMailboxConfigured()) rows.push({ id: 'env:hostinger', provider: 'hostinger', email_address: process.env.HOSTINGER_MAILBOX_ADDRESS!, display_name: 'Aussie Venture', status: 'connected', capabilities: HOSTINGER_CAPABILITIES, token_expires_at: null, scopes: [], is_default_sender: false, last_connected_at: null, last_refreshed_at: null, last_sync_at: null, last_error_code: null, last_error_at: null, created_at: now, updated_at: now })
  const ownsResend = process.env.RESEND_INBOUND_WORKSPACE_ID === workspaceId || process.env.HOSTINGER_WORKSPACE_ID === workspaceId
  if (ownsResend && (process.env.RESEND_API_KEY || process.env.RESEND_API_KEY_V2)) rows.push({ id: 'env:resend', provider: 'resend', email_address: 'hello@aussieventure.com', display_name: 'Aussie Venture', status: 'connected', capabilities: RESEND_CAPABILITIES, token_expires_at: null, scopes: [], is_default_sender: rows.length === 0, last_connected_at: null, last_refreshed_at: null, last_sync_at: null, last_error_code: null, last_error_at: null, created_at: now, updated_at: now })
  return rows
}

export async function GET(): Promise<NextResponse> {
  const context = await requireApiWorkspaceUser()
  if (isApiWorkspaceError(context)) return context
  const rows = (await listMailboxConnections(context.supabase)).map(publicMailboxConnection)
  return NextResponse.json({ data: [...rows, ...environmentConnections(context.workspace.workspaceId)], can_manage: context.workspace.isPlatformAdmin || context.workspace.role === 'owner' || context.workspace.role === 'admin' })
}
