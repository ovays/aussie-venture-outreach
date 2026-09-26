import 'server-only'
import { fetchHostingerReportMessages } from '@/lib/hostinger-mail'
import { HOSTINGER_CAPABILITIES, type MailboxProviderAdapter, type ProviderMailboxMessage } from './types'

export const hostingerProvider: MailboxProviderAdapter = {
  type: 'hostinger', capabilities: HOSTINGER_CAPABILITIES,
  listMessages: async (connection, range) => {
    const mailbox = await fetchHostingerReportMessages(range)
    const convert = (message: typeof mailbox.received[number], direction: 'received' | 'sent'): ProviderMailboxMessage => ({
      provider: 'hostinger', providerMessageId: message.messageId ?? `${message.path}:${message.uid}`,
      mailboxConnectionId: connection?.id ?? null, direction,
      from: message.from?.address ?? (direction === 'sent' ? mailbox.mailboxAddress : ''),
      to: (message.to ?? []).map((recipient) => recipient.address).filter((address): address is string => !!address),
      subject: message.subject ?? null, receivedAt: message.date ?? '', threadId: message.threadId ?? undefined, messageId: message.messageId ?? undefined,
    })
    return [...mailbox.received.map((message) => convert(message, 'received')), ...mailbox.sent.map((message) => convert(message, 'sent'))].filter((message) => !!message.receivedAt)
  },
}

