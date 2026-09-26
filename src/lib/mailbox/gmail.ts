import 'server-only'
import { oauthRedirectUri, requiredMailboxEnv } from './oauth-config'
import { MailboxProviderError, normalizeProviderError } from './errors'
import { GMAIL_CAPABILITIES, type MailboxProviderAdapter, type ProviderMailboxMessage } from './types'

export const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.readonly'] as const

function mimeHeader(value: string, field: string): string {
  if (!value || /[\r\n]/.test(value)) throw new MailboxProviderError('DELIVERY_REJECTED', `Invalid ${field} header`)
  return value
}

function mime(request: Parameters<NonNullable<MailboxProviderAdapter['send']>>[1], from: string): string {
  const headers = [`From: ${mimeHeader(from, 'From')}`, `To: ${mimeHeader(request.to, 'To')}`, `Subject: ${mimeHeader(request.subject, 'Subject')}`, `Message-ID: ${mimeHeader(request.messageId, 'Message-ID')}`, 'MIME-Version: 1.0', 'Content-Type: text/html; charset=UTF-8']
  if (request.references?.length) headers.push(`In-Reply-To: ${mimeHeader(request.references.at(-1)!, 'In-Reply-To')}`, `References: ${mimeHeader(request.references.join(' '), 'References')}`)
  return Buffer.from(`${headers.join('\r\n')}\r\n\r\n${request.html}`).toString('base64url')
}

async function json(fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<Record<string, any>> {
  const response = await fetchImpl(url, { ...init, cache: 'no-store' })
  const body = await response.json().catch(() => ({})) as Record<string, any>
  if (!response.ok && body.error === 'invalid_grant') throw new MailboxProviderError('AUTH_REVOKED', 'Gmail authorization was revoked')
  if (!response.ok) throw normalizeProviderError(new Error('Gmail request failed'), response.status)
  return body
}

function oauthTokens(body: Record<string, any>, fallbackScopes: readonly string[]) {
  if (typeof body.access_token !== 'string' || !body.access_token || !Number.isFinite(Number(body.expires_in))) {
    throw new MailboxProviderError('AUTH_REVOKED', 'Gmail did not return valid authorization credentials')
  }
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === 'string' && body.refresh_token ? body.refresh_token : undefined,
    expiresAt: new Date(Date.now() + Number(body.expires_in) * 1000).toISOString(),
    scopes: String(body.scope || fallbackScopes.join(' ')).split(' ').filter(Boolean),
  }
}

export function createGmailProvider(fetchImpl: typeof fetch = fetch): MailboxProviderAdapter {
  return {
    type: 'gmail', capabilities: GMAIL_CAPABILITIES,
    getAuthorizationUrl: ({ state, codeChallenge }) => {
      const query = new URLSearchParams({ client_id: requiredMailboxEnv('GOOGLE_MAILBOX_CLIENT_ID'), redirect_uri: oauthRedirectUri('gmail'), response_type: 'code', access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', scope: GMAIL_SCOPES.join(' '), state, code_challenge: codeChallenge, code_challenge_method: 'S256' })
      return `https://accounts.google.com/o/oauth2/v2/auth?${query}`
    },
    exchangeAuthorizationCode: async ({ code, codeVerifier }) => {
      const body = await json(fetchImpl, 'https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: requiredMailboxEnv('GOOGLE_MAILBOX_CLIENT_ID'), client_secret: requiredMailboxEnv('GOOGLE_MAILBOX_CLIENT_SECRET'), code, code_verifier: codeVerifier, grant_type: 'authorization_code', redirect_uri: oauthRedirectUri('gmail') }) })
      return oauthTokens(body, GMAIL_SCOPES)
    },
    refreshAuthentication: async (refreshToken) => {
      const body = await json(fetchImpl, 'https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: requiredMailboxEnv('GOOGLE_MAILBOX_CLIENT_ID'), client_secret: requiredMailboxEnv('GOOGLE_MAILBOX_CLIENT_SECRET'), refresh_token: refreshToken, grant_type: 'refresh_token' }) })
      return oauthTokens(body, GMAIL_SCOPES)
    },
    verifyIdentity: async (accessToken) => {
      const body = await json(fetchImpl, 'https://gmail.googleapis.com/gmail/v1/users/me/profile', { headers: { Authorization: `Bearer ${accessToken}` } })
      if (typeof body.emailAddress !== 'string' || !body.emailAddress.includes('@')) throw new MailboxProviderError('PERMISSION_DENIED', 'Gmail mailbox identity could not be verified')
      return { providerAccountId: body.emailAddress, emailAddress: body.emailAddress, displayName: null }
    },
    send: async (connection, request) => {
      if (!connection) throw new Error('Gmail connection required')
      try {
        const accessToken = connection.access_token_encrypted!
        const body = await json(fetchImpl, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ raw: mime(request, connection.email_address), threadId: undefined }) })
        if (typeof body.id !== 'string' || !body.id) throw new Error('Gmail accepted no message identifier')
        return { id: body.id, messageId: request.messageId }
      } catch (error) {
        if (error instanceof MailboxProviderError && ['AUTH_EXPIRED', 'PERMISSION_DENIED', 'RATE_LIMITED', 'INVALID_RECIPIENT', 'DELIVERY_REJECTED'].includes(error.code)) throw error
        throw new MailboxProviderError('DELIVERY_UNCERTAIN', 'Gmail delivery outcome is uncertain', { cause: error })
      }
    },
    listMessages: async (connection, range) => {
      if (!connection) throw new Error('Gmail connection required')
      const accessToken = connection.access_token_encrypted!
      const query = `{in:inbox in:sent} after:${Math.floor(range.startInclusive.getTime() / 1000)} before:${Math.floor(range.endExclusive.getTime() / 1000)}`
      const listed = await json(fetchImpl, `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=200&q=${encodeURIComponent(query)}`, { headers: { Authorization: `Bearer ${accessToken}` } })
      const rows = await Promise.all((listed.messages ?? []).map(async ({ id }: { id: string }) => json(fetchImpl, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Message-ID`, { headers: { Authorization: `Bearer ${accessToken}` } })))
      return rows.map((row): ProviderMailboxMessage => {
        const headers = Object.fromEntries((row.payload?.headers ?? []).map((h: any) => [String(h.name).toLowerCase(), String(h.value)]))
        const labels: string[] = row.labelIds ?? []
        return { provider: 'gmail', providerMessageId: row.id, mailboxConnectionId: connection.id, direction: labels.includes('SENT') ? 'sent' : 'received', from: headers.from ?? '', to: (headers.to ?? '').split(',').map((v: string) => v.trim()).filter(Boolean), subject: headers.subject ?? null, receivedAt: new Date(Number(row.internalDate)).toISOString(), threadId: row.threadId, messageId: headers['message-id'] }
      })
    },
  }
}
