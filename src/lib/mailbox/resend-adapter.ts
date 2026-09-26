import 'server-only'
import { sendEmail, UncertainEmailDeliveryError } from '@/lib/resend'
import { MailboxProviderError } from './errors'
import { RESEND_CAPABILITIES, type MailboxProviderAdapter } from './types'

export const resendProvider: MailboxProviderAdapter = {
  type: 'resend', capabilities: RESEND_CAPABILITIES,
  send: async (_connection, request) => {
    try {
      const result = await sendEmail(request)
      if (!result) throw new MailboxProviderError('DELIVERY_REJECTED', 'Outbound provider rejected the message')
      return result
    } catch (error) {
      if (error instanceof UncertainEmailDeliveryError) throw new MailboxProviderError('DELIVERY_UNCERTAIN', 'Provider delivery outcome is uncertain', { cause: error })
      throw error
    }
  },
}

