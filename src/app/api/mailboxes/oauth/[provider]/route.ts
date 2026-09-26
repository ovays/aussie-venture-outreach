import { NextResponse } from 'next/server'
import { isApiWorkspaceError, requireApiWorkspaceUser } from '@/lib/api-workspace'
import { createPkce, type OAuthMailboxProvider } from '@/lib/mailbox/oauth-config'
import {
  createMailboxOAuthState,
  mailboxOAuthCookieName,
  mailboxOAuthStateFingerprint,
  MAILBOX_OAUTH_STATE_MAX_AGE_SECONDS,
} from '@/lib/mailbox/oauth-state'
import { getMailboxProvider } from '@/lib/mailbox/registry'

function oauthProvider(value: string): OAuthMailboxProvider | null { return value === 'gmail' || value === 'microsoft' ? value : null }

export async function GET(_request: Request, { params }: { params: Promise<{ provider: string }> }): Promise<NextResponse> {
  const context = await requireApiWorkspaceUser()
  if (isApiWorkspaceError(context)) return context
  if (!(context.workspace.isPlatformAdmin || context.workspace.role === 'owner' || context.workspace.role === 'admin')) return NextResponse.json({ error: 'Workspace admin access required' }, { status: 403 })
  const provider = oauthProvider((await params).provider)
  if (!provider) return NextResponse.json({ error: 'Unsupported mailbox provider' }, { status: 404 })
  const pkce = createPkce()
  const state = createMailboxOAuthState({ provider, workspaceId: context.workspace.workspaceId, userId: context.auth.user.id, codeVerifier: pkce.verifier })
  const response = NextResponse.redirect(getMailboxProvider(provider).getAuthorizationUrl!({ state, codeChallenge: pkce.challenge }))
  response.cookies.set(mailboxOAuthCookieName(provider), mailboxOAuthStateFingerprint(state), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: MAILBOX_OAUTH_STATE_MAX_AGE_SECONDS,
    path: `/api/mailboxes/oauth/${provider}/callback`,
  })
  return response
}
