import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/server'
import {
  HOSTINGER_PROCESSING_STALE_MS,
  hostingerInboundReceiptKey,
  type HostingerInboundReceipt,
  type HostingerInboundReceiptStore,
  type InboundReceiptStatus,
} from '@/lib/hostinger-inbound-queue'
import type { HostingerWebhookLocator } from '@/lib/hostinger-webhook'

type ServiceClient = SupabaseClient

interface ReceiptRow {
  id: string
  receipt_key: string
  status: InboundReceiptStatus
  attempts: number
  processing_started_at: string | null
  updated_at: string
}

function receiptFromRow(row: ReceiptRow, duplicate: boolean): HostingerInboundReceipt {
  const processingTimestamp = row.processing_started_at ?? row.updated_at
  const staleProcessing = row.status === 'processing'
    && Date.parse(processingTimestamp) < Date.now() - HOSTINGER_PROCESSING_STALE_MS
  return {
    id: row.id,
    receiptKey: row.receipt_key,
    status: row.status,
    duplicate,
    attemptCount: row.attempts,
    replayable: row.status === 'pending' || row.status === 'failed' || staleProcessing,
  }
}

export function createHostingerInboundReceiptStore(
  supabase: ServiceClient = createServiceClient(),
): HostingerInboundReceiptStore {
  return {
    async register(locator) {
      const receiptKey = hostingerInboundReceiptKey(locator)
      const { data, error } = await supabase
        .from('inbound_receipts')
        .insert({
          provider: 'hostinger',
          receipt_key: receiptKey,
          mailbox_id: locator.mailboxId,
          folder: locator.folder,
          uid: locator.uid ? String(locator.uid) : null,
          provider_message_id: locator.providerMessageId ?? null,
          status: 'pending',
          payload: locator,
        })
        .select('id, receipt_key, status, attempts, processing_started_at, updated_at')
        .single()

      if (!error && data) return receiptFromRow(data as ReceiptRow, false)
      if (error?.code !== '23505') {
        throw new Error(`Inbound receipt registration failed: ${error?.message ?? 'no row returned'}`)
      }

      const existing = await supabase
        .from('inbound_receipts')
        .select('id, receipt_key, status, attempts, processing_started_at, updated_at')
        .eq('receipt_key', receiptKey)
        .single()
      if (existing.error || !existing.data) {
        throw new Error(`Inbound receipt lookup failed: ${existing.error?.message ?? 'no row returned'}`)
      }
      return receiptFromRow(existing.data as ReceiptRow, true)
    },

    async markQueued(receiptId, runId) {
      const { data, error } = await supabase
        .from('inbound_receipts')
        .update({ status: 'queued', trigger_run_id: runId, last_error: null, updated_at: new Date().toISOString() })
        .eq('id', receiptId)
        .in('status', ['pending', 'failed'])
        .select('status')
        .maybeSingle()
      if (error) throw new Error(`Inbound receipt queue state failed: ${error.message}`)
      if (data) return data.status as InboundReceiptStatus

      const current = await supabase.from('inbound_receipts').select('status').eq('id', receiptId).single()
      if (current.error || !current.data) {
        throw new Error(`Inbound receipt queue state could not be verified: ${current.error?.message ?? 'not found'}`)
      }
      return current.data.status as InboundReceiptStatus
    },

    async recordEnqueueError(receiptId, errorMessage) {
      const { error } = await supabase
        .from('inbound_receipts')
        .update({ last_error: errorMessage.slice(0, 2000), updated_at: new Date().toISOString() })
        .eq('id', receiptId)
        .in('status', ['pending', 'failed'])
      if (error) throw new Error(`Inbound receipt enqueue error could not be stored: ${error.message}`)
    },
  }
}

export async function processHostingerInboundReceipt(
  receiptId: string,
  runId: string,
  dependencies?: {
    supabase?: ServiceClient
    fetchMessage?: typeof import('@/lib/hostinger-mail').fetchHostingerInboundMessage
    processReply?: typeof import('../../agents/tracker').processInboundReply
  },
): Promise<{ status: InboundReceiptStatus; skipped?: boolean }> {
  const supabase = dependencies?.supabase ?? createServiceClient()
  const { fetchHostingerInboundMessage } = dependencies?.fetchMessage
    ? { fetchHostingerInboundMessage: dependencies.fetchMessage }
    : await import('@/lib/hostinger-mail')
  const { processInboundReply } = dependencies?.processReply
    ? { processInboundReply: dependencies.processReply }
    : await import('../../agents/tracker')

  const current = await supabase
    .from('inbound_receipts')
    .select('id, status, payload, processing_run_id, processing_started_at, updated_at')
    .eq('id', receiptId)
    .single()
  if (current.error || !current.data) {
    throw new Error(`Inbound receipt could not be loaded: ${current.error?.message ?? 'not found'}`)
  }

  const terminal = new Set<InboundReceiptStatus>([
    'processed', 'ignored', 'unmatched', 'unmatched_ambiguous',
  ])
  const status = current.data.status as InboundReceiptStatus
  if (terminal.has(status)) return { status, skipped: true }
  const staleBefore = new Date(Date.now() - HOSTINGER_PROCESSING_STALE_MS).toISOString()
  const claimed = await supabase.rpc('claim_hostinger_inbound_receipt', {
    p_receipt_id: receiptId,
    p_run_id: runId,
    p_stale_before: staleBefore,
  }).maybeSingle()
  if (claimed.error) throw new Error(`Inbound receipt claim failed: ${claimed.error.message}`)
  if (!claimed.data) return { status, skipped: true }

  try {
    const locator = current.data.payload as unknown as HostingerWebhookLocator
    const message = await fetchHostingerInboundMessage(locator)
    message.receiptId = receiptId
    const result = await processInboundReply(message, supabase)
    const finalStatus: InboundReceiptStatus = result.outcome === 'automated_ignored'
      ? 'ignored'
      : result.outcome
    const completed = await supabase
      .from('inbound_receipts')
      .update({
        status: finalStatus,
        outcome: result.outcome,
        processed_at: new Date().toISOString(),
        last_error: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', receiptId)
      .eq('processing_run_id', runId)
      .eq('status', 'processing')
      .select('id')
      .maybeSingle()
    if (completed.error) throw new Error(`Inbound receipt completion failed: ${completed.error.message}`)
    if (!completed.data) throw new Error('Inbound receipt completion lost its processing claim')
    return { status: finalStatus }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const failed = await supabase
      .from('inbound_receipts')
      .update({ status: 'failed', last_error: message.slice(0, 2000), updated_at: new Date().toISOString() })
      .eq('id', receiptId)
      .eq('processing_run_id', runId)
      .eq('status', 'processing')
      .select('id')
      .maybeSingle()
    if (failed.error) {
      throw new Error(`${message}; additionally, receipt failure state could not be stored: ${failed.error.message}`)
    }
    throw error
  }
}
