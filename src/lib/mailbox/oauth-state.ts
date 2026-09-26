import 'server-only'
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { decryptMailboxCredential, encryptMailboxCredential } from './credential-crypto'
import type { OAuthMailboxProvider } from './oauth-config'

const STATE_TTL_MS = 10 * 60_000
export const MAILBOX_OAUTH_STATE_MAX_AGE_SECONDS = STATE_TTL_MS / 1000
export interface MailboxOAuthState { provider: OAuthMailboxProvider; workspaceId: string; userId: string; codeVerifier: string; expiresAt: number; nonce: string }

export function mailboxOAuthCookieName(provider: OAuthMailboxProvider): string {
  return `reachagent_mailbox_oauth_${provider}`
}

export function mailboxOAuthStateFingerprint(value: string): string {
  return createHash('sha256').update(value).digest('base64url')
}

export function matchesMailboxOAuthStateCookie(state: string, fingerprint: string | undefined): boolean {
  if (!fingerprint) return false
  const expected = Buffer.from(mailboxOAuthStateFingerprint(state))
  const supplied = Buffer.from(fingerprint)
  return expected.length === supplied.length && timingSafeEqual(expected, supplied)
}

export function createMailboxOAuthState(input: Omit<MailboxOAuthState, 'expiresAt' | 'nonce'>): string {
  return encryptMailboxCredential(JSON.stringify({ ...input, expiresAt: Date.now() + STATE_TTL_MS, nonce: randomUUID() }))
}

export function verifyMailboxOAuthState(value: string, expectedProvider: OAuthMailboxProvider): MailboxOAuthState {
  let state: MailboxOAuthState
  try { state = JSON.parse(decryptMailboxCredential(value)) as MailboxOAuthState } catch { throw new Error('Invalid OAuth state') }
  if (state.provider !== expectedProvider || !state.workspaceId || !state.userId || !state.codeVerifier || !state.nonce) throw new Error('Invalid OAuth state')
  if (!Number.isFinite(state.expiresAt) || state.expiresAt <= Date.now()) throw new Error('OAuth state expired')
  return state
}
