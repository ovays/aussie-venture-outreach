import { NextRequest, NextResponse } from 'next/server'
import { isApiWorkspaceError, requireApiWorkspaceUser } from '@/lib/api-workspace'
import { getMailboxConnection } from '@/lib/mailbox/connections'

function canManage(context: Awaited<ReturnType<typeof requireApiWorkspaceUser>>): context is Exclude<typeof context, NextResponse> {
  return !(context instanceof NextResponse) && (context.workspace.isPlatformAdmin || context.workspace.role === 'owner' || context.workspace.role === 'admin')
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const context = await requireApiWorkspaceUser()
  if (isApiWorkspaceError(context)) return context
  if (!canManage(context)) return NextResponse.json({ error: 'Workspace admin access required' }, { status: 403 })
  const { id } = await params
  if (id.startsWith('env:')) return NextResponse.json({ error: 'Environment-backed mailboxes cannot be disconnected here' }, { status: 400 })
  if (!await getMailboxConnection(context.supabase, id)) return NextResponse.json({ error: 'Mailbox not found' }, { status: 404 })
  const { error } = await context.supabase.from('mailbox_connections').update({ status: 'disconnected', is_default_sender: false, access_token_encrypted: null, refresh_token_encrypted: null, token_expires_at: null }).eq('id', id)
  if (error) return NextResponse.json({ error: 'Unable to disconnect mailbox' }, { status: 500 })
  return NextResponse.json({ ok: true })
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const context = await requireApiWorkspaceUser()
  if (isApiWorkspaceError(context)) return context
  if (!canManage(context)) return NextResponse.json({ error: 'Workspace admin access required' }, { status: 403 })
  const { id } = await params
  const body = await request.json().catch(() => ({})) as { default_sender?: unknown }
  if (body.default_sender !== true) return NextResponse.json({ error: 'Unsupported mailbox update' }, { status: 400 })
  const mailbox = await getMailboxConnection(context.supabase, id)
  if (!mailbox || mailbox.status !== 'connected' || !mailbox.capabilities.canSend) return NextResponse.json({ error: 'Mailbox cannot be used for sending' }, { status: 400 })
  await context.supabase.from('mailbox_connections').update({ is_default_sender: false }).eq('is_default_sender', true)
  const { error } = await context.supabase.from('mailbox_connections').update({ is_default_sender: true }).eq('id', id)
  if (error) return NextResponse.json({ error: 'Unable to select sending mailbox' }, { status: 500 })
  return NextResponse.json({ ok: true })
}
