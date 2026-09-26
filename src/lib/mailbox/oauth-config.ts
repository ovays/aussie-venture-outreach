import 'server-only'
import { createHash, randomBytes } from 'node:crypto'
import type { MailboxProviderType } from './types'

export type OAuthMailboxProvider = Extract<MailboxProviderType, 'gmail' | 'microsoft'>

export function createPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

export function oauthRedirectUri(provider: OAuthMailboxProvider): string {
  const configured = process.env.MAILBOX_OAUTH_REDIRECT_BASE_URL || process.env.NEXT_PUBLIC_APP_URL || ''
  let base: URL
  try { base = new URL(configured) } catch { throw new Error('MAILBOX_OAUTH_REDIRECT_BASE_URL is not configured') }
  if ((base.protocol !== 'http:' && base.protocol !== 'https:') || base.username || base.password || base.search || base.hash) {
    throw new Error('MAILBOX_OAUTH_REDIRECT_BASE_URL must be an HTTP(S) origin')
  }
  if (process.env.NODE_ENV === 'production' && base.protocol !== 'https:') throw new Error('Mailbox OAuth requires HTTPS in production')
  return `${base.origin}/api/mailboxes/oauth/${provider}/callback`
}

export function requiredMailboxEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is not configured`)
  return value
}
