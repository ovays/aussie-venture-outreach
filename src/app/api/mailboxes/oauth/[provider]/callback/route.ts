import { NextRequest, NextResponse } from 'next/server'
import { isAuthErrorResponse, requireApiUser } from '@/lib/auth'
import { requireWorkspaceContext } from '@/lib/workspace-context'
import { createWorkspaceServiceClient } from '@/lib/supabase/workspace-service'
import { mailboxOAuthCookieName, matchesMailboxOAuthStateCookie, verifyMailboxOAuthState } from '@/lib/mailbox/oauth-state'
import { getMailboxProvider } from '@/lib/mailbox/registry'
import { upsertOAuthMailbox } from '@/lib/mailbox/connections'
import { oauthRedirectUri, type OAuthMailboxProvider } from '@/lib/mailbox/oauth-config'

function redirect(request: NextRequest, provider: OAuthMailboxProvider, result: 'connected' | 'error'): NextResponse {
  const response = NextResponse.redirect(new URL(`/dashboard/settings?mailbox=${result}#mailboxes`, oauthRedirectUri(provider)))
  response.cookies.set(mailboxOAuthCookieName(provider), '', {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 0,
    path: `/api/mailboxes/oauth/${provider}/callback`,
  })
  return response
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ provider: string }> }): Promise<NextResponse> {
  const rawProvider = (await params).provider
  if (rawProvider !== 'gmail' && rawProvider !== 'microsoft') return NextResponse.redirect(new URL('/dashboard/settings?mailbox=error#mailboxes', process.env.MAILBOX_OAUTH_REDIRECT_BASE_URL || process.env.NEXT_PUBLIC_APP_URL || request.url))
  const provider = rawProvider as OAuthMailboxProvider
  const code = request.nextUrl.searchParams.get('code')
  const rawState = request.nextUrl.searchParams.get('state')
  const stateCookie = request.cookies.get(mailboxOAuthCookieName(provider))?.value
  if (!code || !rawState || request.nextUrl.searchParams.has('error') || !matchesMailboxOAuthStateCookie(rawState, stateCookie)) return redirect(request, provider, 'error')
  try {
    const auth = await requireApiUser()
    if (isAuthErrorResponse(auth)) return redirect(request, provider, 'error')
    const state = verifyMailboxOAuthState(rawState, provider)
    if (state.userId !== auth.user.id) return redirect(request, provider, 'error')
    const workspace = await requireWorkspaceContext(auth, state.workspaceId)
    if (!(workspace.isPlatformAdmin || workspace.role === 'owner' || workspace.role === 'admin')) return redirect(request, provider, 'error')
    const adapter = getMailboxProvider(provider)
    const tokens = await adapter.exchangeAuthorizationCode!({ code, codeVerifier: state.codeVerifier })
    const identity = await adapter.verifyIdentity!(tokens.accessToken)
    await upsertOAuthMailbox(createWorkspaceServiceClient(workspace.workspaceId), { workspaceId: workspace.workspaceId, userId: auth.user.id, provider, identity, tokens })
    return redirect(request, provider, 'connected')
  } catch { return redirect(request, provider, 'error') }
}
