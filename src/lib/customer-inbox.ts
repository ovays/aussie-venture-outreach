import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { toSupabaseRange, type Pagination } from '@/lib/pagination'

type Db = SupabaseClient<Database>
type UnsafeDb = SupabaseClient<any>

export const CUSTOMER_INBOX_PAGE_SIZE = 25
export const CUSTOMER_INBOX_MESSAGE_LIMIT = 50

export async function listCustomerConversations(db: Db, pagination: Pagination) {
  const { from, to } = toSupabaseRange(pagination)
  const result = await db.from('leads').select(
    'id,business_name,email,status,customer_outcome,outreach_suppression_reason,outreach_suppressed_at,emails!inner(id,subject,sent_at,replied_at,created_at)',
    { count: 'exact' },
  ).not('emails.sent_at', 'is', null)
    .order('updated_at', { ascending: false }).range(from, to)
  if (result.error) throw new Error(result.error.message)

  const leadIds = (result.data ?? []).map((row) => row.id)
  const inbound = leadIds.length ? await (db as UnsafeDb).from('customer_inbound_messages')
    .select('lead_id,received_at').in('lead_id', leadIds).order('received_at', { ascending: false }) : { data: [], error: null }
  if (inbound.error) throw new Error(inbound.error.message)
  const latestInbound = new Map<string, string>()
  for (const row of inbound.data ?? []) if (!latestInbound.has(row.lead_id)) latestInbound.set(row.lead_id, row.received_at)

  return {
    data: (result.data ?? []).map((lead) => {
      const emails = Array.isArray(lead.emails) ? lead.emails : []
      const latest = [...emails].sort((a, b) => String(b.sent_at ?? b.created_at).localeCompare(String(a.sent_at ?? a.created_at)))[0]
      const replyAt = latestInbound.get(lead.id) ?? emails.map((email) => email.replied_at).filter(Boolean).sort().at(-1) ?? null
      const lastAt = [latest?.sent_at, replyAt].filter(Boolean).sort().at(-1) ?? null
      return {
        id: lead.id, business_name: lead.business_name, email: lead.email,
        subject: latest?.subject ?? null, last_message_at: lastAt,
        state: replyAt ? 'replied' : 'sent', outcome: lead.customer_outcome,
        suppression: lead.outreach_suppressed_at ? 'suppressed' : null,
      }
    }),
    total: result.count ?? 0, page: pagination.page, page_size: pagination.pageSize,
  }
}

export async function getCustomerConversation(db: Db, leadId: string) {
  const leadResult = await db.from('leads').select(
    'id,business_name,email,status,customer_outcome,outreach_suppression_reason,outreach_suppressed_at',
  ).eq('id', leadId).maybeSingle()
  if (leadResult.error || !leadResult.data) return null
  const lead = leadResult.data
  const [sent, received, mailbox, suppression] = await Promise.all([
    db.from('emails').select('id,subject,body_text,sent_at,created_at,status').eq('lead_id', leadId)
      .not('sent_at', 'is', null).order('sent_at', { ascending: true }).limit(CUSTOMER_INBOX_MESSAGE_LIMIT),
    (db as UnsafeDb).from('customer_inbound_messages').select('id,from_address,to_addresses,subject,body_text,received_at')
      .eq('lead_id', leadId).order('received_at', { ascending: true }).limit(CUSTOMER_INBOX_MESSAGE_LIMIT),
    db.from('mailbox_connections').select('email_address').eq('status', 'connected').eq('is_default_sender', true).limit(1).maybeSingle(),
    (db as UnsafeDb).from('outreach_suppressions').select('source,suppressed_at').eq('normalized_email', (lead.email ?? '').trim().toLowerCase()).maybeSingle(),
  ])
  if (sent.error || received.error) throw new Error(sent.error?.message ?? received.error?.message)
  const messages = [
    ...(sent.data ?? []).map((row) => ({ id: row.id, direction: 'sent' as const, subject: row.subject, body: row.body_text, occurred_at: row.sent_at ?? row.created_at, from: mailbox.data?.email_address ?? null, to: lead.email })),
    ...(received.data ?? []).map((row: any) => ({ id: row.id, direction: 'received' as const, subject: row.subject, body: row.body_text, occurred_at: row.received_at, from: row.from_address, to: row.to_addresses?.[0] ?? mailbox.data?.email_address ?? null })),
  ].sort((a, b) => String(a.occurred_at).localeCompare(String(b.occurred_at))).slice(-CUSTOMER_INBOX_MESSAGE_LIMIT)
  return {
    id: lead.id, business_name: lead.business_name, email: lead.email,
    outcome: lead.customer_outcome, status: lead.status,
    suppression: suppression.data ? (suppression.data.source === 'recipient_unsubscribe' ? 'unsubscribed' : 'do_not_contact') : lead.outreach_suppressed_at ? 'suppressed' : null,
    messages,
    sync_notice: 'Replies appear after they are safely stored by a connected provider. Gmail and Microsoft automatic reply sync is not active yet.',
  }
}
