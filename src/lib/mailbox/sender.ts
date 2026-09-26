import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { ensureFreshAccessToken, listMailboxConnections } from './connections'
import { MailboxProviderError } from './errors'
import { getMailboxProvider } from './registry'
import type { MailboxSendRequest, MailboxSendResult } from './types'
import { assertOutreachSendEnabled } from '@/lib/side-effect-safety'
import { assertCanaryProviderBoundary, isV2CanaryEnabled } from '@/lib/v2-canary-safety'
import { requireWorkspaceIdForServiceClient } from '@/lib/supabase/workspace-service'
import { consumeOutboundEmailQuota } from '@/lib/quota/gate'

export async function sendThroughWorkspaceMailbox(supabase: SupabaseClient<Database>, request: MailboxSendRequest): Promise<MailboxSendResult> {
  assertOutreachSendEnabled('Mailbox provider delivery')
  assertCanaryProviderBoundary({ leadId: request.leadId, phase: request.phase })
  try {
    const workspaceId = requireWorkspaceIdForServiceClient(supabase)
    await consumeOutboundEmailQuota(workspaceId, request.emailIntentId)
    // P16/P17 canary approval hashes and the dedicated canary credential are
    // bound to the existing Resend sender identity. Never substitute an OAuth
    // mailbox while canary mode is active.
    if (isV2CanaryEnabled()) return await getMailboxProvider('resend').send!(null, request)
    const claim = await supabase.from('emails').update({
      status: 'sending',
      claimed_at: new Date().toISOString(),
      message_id: request.messageId,
    }).eq('id', request.emailIntentId).eq('lead_id', request.leadId).eq('status', 'pending_send').select('id').maybeSingle()
    if (claim.error) throw new MailboxProviderError('UNKNOWN_PROVIDER_ERROR', 'Unable to claim the outbound email intent')
    if (!claim.data) throw new MailboxProviderError('SEND_INTENT_CONFLICT', 'Outbound email intent is already claimed or resolved')

    const connections = await listMailboxConnections(supabase)
    const selected = connections.find((row) => row.is_default_sender && row.status === 'connected' && row.capabilities.canSend)
    if (!selected) return await getMailboxProvider('resend').send!(null, request)
    const connection = await ensureFreshAccessToken(supabase, selected)
    return await getMailboxProvider(connection.provider).send!(connection, request)
  } catch (error) {
    if (error instanceof MailboxProviderError && error.code === 'DELIVERY_UNCERTAIN') {
      await supabase.from('emails').update({ status: 'delivery_uncertain' }).eq('id', request.emailIntentId)
    }
    throw error
  }
}
