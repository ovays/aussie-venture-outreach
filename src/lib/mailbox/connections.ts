import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database, Json } from '@/types/database'
import { decryptMailboxCredential, encryptMailboxCredential } from './credential-crypto'
import { getMailboxProvider } from './registry'
import { MailboxProviderError, normalizeProviderError } from './errors'
import type { MailboxConnectionRecord, PublicMailboxConnection } from './types'

type Client = SupabaseClient<Database>
const TOKEN_REFRESH_WINDOW_MS = 60_000

function asConnection(value: unknown): MailboxConnectionRecord { return value as MailboxConnectionRecord }
export function publicMailboxConnection(row: MailboxConnectionRecord): PublicMailboxConnection {
  const { workspace_id: _workspace, provider_account_id: _account, access_token_encrypted: _access, refresh_token_encrypted: _refresh, created_by: _creator, ...safe } = row
  return safe
}

export async function listMailboxConnections(supabase: Client): Promise<MailboxConnectionRecord[]> {
  const { data, error } = await supabase.from('mailbox_connections').select('*').order('created_at')
  if (error) throw new Error(error.message)
  return (data ?? []).map(asConnection)
}

export async function getMailboxConnection(supabase: Client, id: string): Promise<MailboxConnectionRecord | null> {
  const { data, error } = await supabase.from('mailbox_connections').select('*').eq('id', id).maybeSingle()
  if (error) throw new Error(error.message)
  return data ? asConnection(data) : null
}

export async function getUsableMailboxConnection(supabase: Client, id: string): Promise<MailboxConnectionRecord> {
  const row = await getMailboxConnection(supabase, id)
  if (!row || row.status !== 'connected') throw new MailboxProviderError('PERMISSION_DENIED', 'Mailbox connection is not available in this workspace')
  return ensureFreshAccessToken(supabase, row)
}

export async function ensureFreshAccessToken(supabase: Client, row: MailboxConnectionRecord): Promise<MailboxConnectionRecord> {
  if (!row.capabilities.canRefreshAuth || !row.access_token_encrypted) return row
  const expires = row.token_expires_at ? Date.parse(row.token_expires_at) : 0
  if (expires > Date.now() + TOKEN_REFRESH_WINDOW_MS) return { ...row, access_token_encrypted: decryptMailboxCredential(row.access_token_encrypted) }
  if (!row.refresh_token_encrypted) {
    await supabase.from('mailbox_connections').update({ status: 'expired', last_error_code: 'AUTH_EXPIRED', last_error_at: new Date().toISOString() }).eq('id', row.id)
    throw new MailboxProviderError('AUTH_EXPIRED', 'Mailbox authorization has expired')
  }
  const provider = getMailboxProvider(row.provider)
  try {
    const tokens = await provider.refreshAuthentication!(decryptMailboxCredential(row.refresh_token_encrypted))
    const update = {
      access_token_encrypted: encryptMailboxCredential(tokens.accessToken),
      refresh_token_encrypted: tokens.refreshToken ? encryptMailboxCredential(tokens.refreshToken) : row.refresh_token_encrypted,
      token_expires_at: tokens.expiresAt, scopes: tokens.scopes,
      last_refreshed_at: new Date().toISOString(), last_error_code: null, last_error_at: null, status: 'connected',
    }
    const { data, error } = await supabase.from('mailbox_connections').update(update).eq('id', row.id).eq('updated_at', row.updated_at).select('*').maybeSingle()
    if (error) throw new Error(error.message)
    const latest = data ? asConnection(data) : (await getMailboxConnection(supabase, row.id))!
    return { ...latest, access_token_encrypted: decryptMailboxCredential(latest.access_token_encrypted!) }
  } catch (error) {
    const normalized = normalizeProviderError(error)
    const permanentlyInvalid = normalized.code === 'AUTH_EXPIRED' || normalized.code === 'AUTH_REVOKED' || normalized.code === 'PERMISSION_DENIED'
    await supabase.from('mailbox_connections').update({
      status: permanentlyInvalid ? 'expired' : 'connected',
      last_error_code: normalized.code,
      last_error_at: new Date().toISOString(),
    }).eq('id', row.id)
    if (permanentlyInvalid) throw new MailboxProviderError('AUTH_REVOKED', 'Mailbox authorization must be reconnected', { cause: error })
    throw normalized
  }
}

export async function upsertOAuthMailbox(supabase: Client, input: { workspaceId: string; userId: string; provider: 'gmail' | 'microsoft'; identity: { providerAccountId: string; emailAddress: string; displayName: string | null }; tokens: { accessToken: string; refreshToken?: string; expiresAt: string; scopes: string[] } }): Promise<void> {
  const capabilities = getMailboxProvider(input.provider).capabilities as unknown as Json
  const now = new Date().toISOString()
  const existing = await supabase.from('mailbox_connections').select('refresh_token_encrypted')
    .eq('provider', input.provider).eq('provider_account_id', input.identity.providerAccountId).maybeSingle()
  if (existing.error) throw new Error(existing.error.message)
  const refreshToken = input.tokens.refreshToken
    ? encryptMailboxCredential(input.tokens.refreshToken)
    : existing.data?.refresh_token_encrypted ?? null
  if (!refreshToken) throw new MailboxProviderError('AUTH_REVOKED', 'Mailbox provider did not grant offline access')
  const { error } = await supabase.from('mailbox_connections').upsert({ workspace_id: input.workspaceId, provider: input.provider, provider_account_id: input.identity.providerAccountId, email_address: input.identity.emailAddress.toLowerCase(), display_name: input.identity.displayName, status: 'connected', capabilities, access_token_encrypted: encryptMailboxCredential(input.tokens.accessToken), refresh_token_encrypted: refreshToken, token_expires_at: input.tokens.expiresAt, scopes: input.tokens.scopes, last_connected_at: now, last_error_code: null, last_error_at: null, created_by: input.userId }, { onConflict: 'workspace_id,provider,provider_account_id' })
  if (error) throw new Error(error.message)
}
