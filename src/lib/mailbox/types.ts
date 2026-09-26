export const MAILBOX_PROVIDERS = ['gmail', 'microsoft', 'hostinger', 'resend'] as const
export type MailboxProviderType = typeof MAILBOX_PROVIDERS[number]
export type MailboxConnectionStatus = 'connected' | 'expired' | 'error' | 'disconnected'

export interface MailboxCapabilities {
  canSend: boolean
  canReadInbox: boolean
  canReadSent: boolean
  canRefreshAuth: boolean
  canReceiveWebhooks: boolean
}

export interface MailboxConnectionRecord {
  id: string
  workspace_id: string
  provider: MailboxProviderType
  email_address: string
  display_name: string | null
  status: MailboxConnectionStatus
  capabilities: MailboxCapabilities
  provider_account_id: string | null
  access_token_encrypted: string | null
  refresh_token_encrypted: string | null
  token_expires_at: string | null
  scopes: string[]
  is_default_sender: boolean
  last_connected_at: string | null
  last_refreshed_at: string | null
  last_sync_at: string | null
  last_error_code: string | null
  last_error_at: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

export type PublicMailboxConnection = Omit<MailboxConnectionRecord,
  'workspace_id' | 'provider_account_id' | 'access_token_encrypted' | 'refresh_token_encrypted' | 'created_by'>

export interface MailboxSendRequest {
  to: string
  subject: string
  html: string
  text: string
  leadId: string
  references?: string[]
  idempotencyKey: string
  messageId: string
  emailIntentId: string
  phase: string
}

export interface MailboxSendResult { id: string; messageId: string }

export interface ProviderMailboxMessage {
  provider: MailboxProviderType
  providerMessageId: string
  mailboxConnectionId: string | null
  direction: 'received' | 'sent'
  from: string
  to: string[]
  subject: string | null
  receivedAt: string
  threadId?: string
  messageId?: string
  status?: string
}

export interface NormalizedInboundProviderMessage {
  provider: MailboxProviderType
  providerMessageId: string
  mailboxConnectionId: string | null
  from: string
  to: string[]
  subject?: string
  receivedAt?: string
  threadId?: string
  messageId?: string
  inReplyTo?: string[]
  references?: string[]
  headers?: Record<string, string>
  textPreview?: string
}

export interface OAuthIdentity { providerAccountId: string; emailAddress: string; displayName: string | null }
export interface OAuthTokens { accessToken: string; refreshToken?: string; expiresAt: string; scopes: string[] }

export interface MailboxProviderAdapter {
  readonly type: MailboxProviderType
  readonly capabilities: MailboxCapabilities
  getAuthorizationUrl?(input: { state: string; codeChallenge: string }): string
  exchangeAuthorizationCode?(input: { code: string; codeVerifier: string }): Promise<OAuthTokens>
  refreshAuthentication?(refreshToken: string): Promise<OAuthTokens>
  verifyIdentity?(accessToken: string): Promise<OAuthIdentity>
  send?(connection: MailboxConnectionRecord | null, request: MailboxSendRequest): Promise<MailboxSendResult>
  listMessages?(connection: MailboxConnectionRecord | null, range: { startInclusive: Date; endExclusive: Date }): Promise<ProviderMailboxMessage[]>
}

export const GMAIL_CAPABILITIES: MailboxCapabilities = { canSend: true, canReadInbox: true, canReadSent: true, canRefreshAuth: true, canReceiveWebhooks: false }
export const MICROSOFT_CAPABILITIES: MailboxCapabilities = { canSend: true, canReadInbox: true, canReadSent: true, canRefreshAuth: true, canReceiveWebhooks: false }
export const HOSTINGER_CAPABILITIES: MailboxCapabilities = { canSend: false, canReadInbox: true, canReadSent: true, canRefreshAuth: false, canReceiveWebhooks: true }
export const RESEND_CAPABILITIES: MailboxCapabilities = { canSend: true, canReadInbox: false, canReadSent: false, canRefreshAuth: false, canReceiveWebhooks: true }

