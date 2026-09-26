import 'server-only'
import { oauthRedirectUri, requiredMailboxEnv } from './oauth-config'
import { MailboxProviderError, normalizeProviderError } from './errors'
import { MICROSOFT_CAPABILITIES, type MailboxProviderAdapter, type ProviderMailboxMessage } from './types'

export const MICROSOFT_SCOPES = ['offline_access', 'User.Read', 'Mail.Read', 'Mail.Send'] as const
const graph = 'https://graph.microsoft.com/v1.0'

function mimeHeader(value: string, field: string): string {
  if (!value || /[\r\n]/.test(value)) throw new MailboxProviderError('DELIVERY_REJECTED', `Invalid ${field} header`)
  return value
}

function mime(request: Parameters<NonNullable<MailboxProviderAdapter['send']>>[1], from: string): string {
  const headers = [`From: ${mimeHeader(from, 'From')}`, `To: ${mimeHeader(request.to, 'To')}`, `Subject: ${mimeHeader(request.subject, 'Subject')}`, `Message-ID: ${mimeHeader(request.messageId, 'Message-ID')}`, 'MIME-Version: 1.0', 'Content-Type: text/html; charset=UTF-8']
  if (request.references?.length) headers.push(`In-Reply-To: ${mimeHeader(request.references.at(-1)!, 'In-Reply-To')}`, `References: ${mimeHeader(request.references.join(' '), 'References')}`)
  return Buffer.from(`${headers.join('\r\n')}\r\n\r\n${request.html}`).toString('base64')
}

async function request(fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<Record<string, any>> {
  const response = await fetchImpl(url, { ...init, cache: 'no-store' })
  if (response.status === 202 || response.status === 204) return {}
  const body = await response.json().catch(() => ({})) as Record<string, any>
  if (!response.ok && body.error === 'invalid_grant') throw new MailboxProviderError('AUTH_REVOKED', 'Microsoft authorization was revoked')
  if (!response.ok) throw normalizeProviderError(new Error('Microsoft mailbox request failed'), response.status)
  return body
}

function tenant(): string { return process.env.MICROSOFT_MAILBOX_TENANT_ID?.trim() || 'common' }

function oauthTokens(body: Record<string, any>) {
  if (typeof body.access_token !== 'string' || !body.access_token || !Number.isFinite(Number(body.expires_in))) {
    throw new MailboxProviderError('AUTH_REVOKED', 'Microsoft did not return valid authorization credentials')
  }
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === 'string' && body.refresh_token ? body.refresh_token : undefined,
    expiresAt: new Date(Date.now() + Number(body.expires_in) * 1000).toISOString(),
    scopes: String(body.scope || MICROSOFT_SCOPES.join(' ')).split(' ').filter(Boolean),
  }
}

export function createMicrosoftProvider(fetchImpl: typeof fetch = fetch): MailboxProviderAdapter {
  return {
    type: 'microsoft', capabilities: MICROSOFT_CAPABILITIES,
    getAuthorizationUrl: ({ state, codeChallenge }) => {
      const query = new URLSearchParams({ client_id: requiredMailboxEnv('MICROSOFT_MAILBOX_CLIENT_ID'), redirect_uri: oauthRedirectUri('microsoft'), response_type: 'code', response_mode: 'query', scope: MICROSOFT_SCOPES.join(' '), state, code_challenge: codeChallenge, code_challenge_method: 'S256' })
      return `https://login.microsoftonline.com/${encodeURIComponent(tenant())}/oauth2/v2.0/authorize?${query}`
    },
    exchangeAuthorizationCode: async ({ code, codeVerifier }) => {
      const body = await request(fetchImpl, `https://login.microsoftonline.com/${encodeURIComponent(tenant())}/oauth2/v2.0/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: requiredMailboxEnv('MICROSOFT_MAILBOX_CLIENT_ID'), client_secret: requiredMailboxEnv('MICROSOFT_MAILBOX_CLIENT_SECRET'), code, code_verifier: codeVerifier, grant_type: 'authorization_code', redirect_uri: oauthRedirectUri('microsoft'), scope: MICROSOFT_SCOPES.join(' ') }) })
      return oauthTokens(body)
    },
    refreshAuthentication: async (refreshToken) => {
      const body = await request(fetchImpl, `https://login.microsoftonline.com/${encodeURIComponent(tenant())}/oauth2/v2.0/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: requiredMailboxEnv('MICROSOFT_MAILBOX_CLIENT_ID'), client_secret: requiredMailboxEnv('MICROSOFT_MAILBOX_CLIENT_SECRET'), refresh_token: refreshToken, grant_type: 'refresh_token', scope: MICROSOFT_SCOPES.join(' ') }) })
      return oauthTokens(body)
    },
    verifyIdentity: async (accessToken) => {
      const body = await request(fetchImpl, `${graph}/me?$select=id,displayName,mail,userPrincipalName`, { headers: { Authorization: `Bearer ${accessToken}` } })
      const email = body.mail || body.userPrincipalName
      if (typeof body.id !== 'string' || !body.id || typeof email !== 'string' || !email.includes('@')) throw new MailboxProviderError('PERMISSION_DENIED', 'Microsoft mailbox identity could not be verified')
      return { providerAccountId: body.id, emailAddress: email, displayName: body.displayName ?? null }
    },
    send: async (connection, sendRequest) => {
      if (!connection) throw new Error('Microsoft connection required')
      try {
        await request(fetchImpl, `${graph}/me/sendMail`, { method: 'POST', headers: { Authorization: `Bearer ${connection.access_token_encrypted}`, 'content-type': 'text/plain' }, body: mime(sendRequest, connection.email_address) })
        return { id: `microsoft:${sendRequest.idempotencyKey}`, messageId: sendRequest.messageId }
      } catch (error) {
        if (error instanceof MailboxProviderError && ['AUTH_EXPIRED', 'PERMISSION_DENIED', 'RATE_LIMITED', 'INVALID_RECIPIENT', 'DELIVERY_REJECTED'].includes(error.code)) throw error
        throw new MailboxProviderError('DELIVERY_UNCERTAIN', 'Microsoft delivery outcome is uncertain', { cause: error })
      }
    },
    listMessages: async (connection, range) => {
      if (!connection) throw new Error('Microsoft connection required')
      const auth = { Authorization: `Bearer ${connection.access_token_encrypted}` }
      const filter = encodeURIComponent(`receivedDateTime ge ${range.startInclusive.toISOString()} and receivedDateTime lt ${range.endExclusive.toISOString()}`)
      const select = 'id,conversationId,internetMessageId,subject,from,toRecipients,receivedDateTime,sentDateTime,isDraft'
      const [inbox, sent] = await Promise.all([
        request(fetchImpl, `${graph}/me/mailFolders/inbox/messages?$top=200&$filter=${filter}&$select=${select}`, { headers: auth }),
        request(fetchImpl, `${graph}/me/mailFolders/sentitems/messages?$top=200&$filter=${filter.replaceAll('receivedDateTime', 'sentDateTime')}&$select=${select}`, { headers: auth }),
      ])
      const convert = (row: any, direction: 'received' | 'sent'): ProviderMailboxMessage => ({ provider: 'microsoft', providerMessageId: row.id, mailboxConnectionId: connection.id, direction, from: row.from?.emailAddress?.address ?? connection.email_address, to: (row.toRecipients ?? []).map((item: any) => item.emailAddress?.address).filter(Boolean), subject: row.subject ?? null, receivedAt: row.receivedDateTime ?? row.sentDateTime, threadId: row.conversationId, messageId: row.internetMessageId })
      return [...(inbox.value ?? []).map((row: any) => convert(row, 'received')), ...(sent.value ?? []).map((row: any) => convert(row, 'sent'))]
    },
  }
}
