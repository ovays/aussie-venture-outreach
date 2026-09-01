import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/server'
import {
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
}

function receiptFromRow(row: ReceiptRow, duplicate: boolean): HostingerInboundReceipt {
  return {
    id: row.id,
    receiptKey: row.receipt_key,
    status: row.status,
    duplicate,
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
        .select('id, receipt_key, status')
        .single()

      if (!error && data) return receiptFromRow(data as ReceiptRow, false)
      if (error?.code !== '23505') {
        throw new Error(`Inbound receipt registration failed: ${error?.message ?? 'no row returned'}`)
      }

      const existing = await supabase
        .from('inbound_receipts')
        .select('id, receipt_key, status')
        .eq('receipt_key', receiptKey)
        .single()
      if (existing.error || !existing.data) {
        throw new Error(`Inbound receipt lookup failed: ${existing.error?.message ?? 'no row returned'}`)
      }
      return receiptFromRow(existing.data as ReceiptRow, true)
    },

    async markQueued(receiptId, runId) {
      const { error } = await supabase
        .from('inbound_receipts')
        .update({ status: 'queued', trigger_run_id: runId, last_error: null, updated_at: new Date().toISOString() })
        .eq('id', receiptId)
        .eq('status', 'pending')
      if (error) throw new Error(`Inbound receipt queue state failed: ${error.message}`)
    },

    async recordEnqueueError(receiptId, errorMessage) {
      const { error } = await supabase
        .from('inbound_receipts')
        .update({ last_error: errorMessage.slice(0, 2000), updated_at: new Date().toISOString() })
        .eq('id', receiptId)
        .eq('status', 'pending')
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
    .select('id, status, payload, processing_run_id')
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
  if (status === 'processing' && current.data.processing_run_id !== runId) {
    return { status, skipped: true }
  }

  let claim = supabase
    .from('inbound_receipts')
    .update({
      status: 'processing',
      processing_run_id: runId,
      processing_started_at: new Date().toISOString(),
      last_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', receiptId)
  claim = status === 'processing'
    ? claim.eq('processing_run_id', runId)
    : claim.eq('status', status)
  const claimed = await claim.select('id').maybeSingle()
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
    if (completed.error) throw new Error(`Inbound receipt completion failed: ${completed.error.message}`)
    return { status: finalStatus }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await supabase
      .from('inbound_receipts')
      .update({ status: 'failed', last_error: message.slice(0, 2000), updated_at: new Date().toISOString() })
      .eq('id', receiptId)
      .eq('processing_run_id', runId)
    throw error
  }
}
