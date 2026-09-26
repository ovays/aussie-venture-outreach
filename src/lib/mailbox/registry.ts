import 'server-only'
import { createGmailProvider } from './gmail'
import { hostingerProvider } from './hostinger'
import { createMicrosoftProvider } from './microsoft'
import { resendProvider } from './resend-adapter'
import type { MailboxProviderAdapter, MailboxProviderType } from './types'

const registry: Record<MailboxProviderType, MailboxProviderAdapter> = {
  gmail: createGmailProvider(), microsoft: createMicrosoftProvider(), hostinger: hostingerProvider, resend: resendProvider,
}

export function getMailboxProvider(provider: MailboxProviderType): MailboxProviderAdapter { return registry[provider] }

