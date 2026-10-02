import 'server-only'
import { createHash, randomBytes } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { requireWorkspaceIdForServiceClient, workspaceRow } from '@/lib/supabase/workspace-service'

type UnsafeDb = SupabaseClient<any>
export function normalizeSuppressionEmail(email: string): string { return email.trim().toLowerCase() }
export function unsubscribeTokenHash(token: string): string { return createHash('sha256').update(token).digest('hex') }
export function validOpaqueUnsubscribeToken(token: string): boolean { return /^[A-Za-z0-9_-]{43}$/.test(token) }

export async function ensureUnsubscribeToken(db: SupabaseClient<Database>, leadId: string, email: string): Promise<string> {
  const workspaceId = requireWorkspaceIdForServiceClient(db)
  const normalized = normalizeSuppressionEmail(email)
  // A fresh opaque token is generated when materialising a send. Existing
  // unused tokens are intentionally not recoverable because only hashes persist.
  const token = randomBytes(32).toString('base64url')
  const tokenHash = unsubscribeTokenHash(token)
  const result = await (db as UnsafeDb).from('unsubscribe_tokens').upsert({
    workspace_id: workspaceId, lead_id: leadId, normalized_email: normalized, token_hash: tokenHash, used_at: null,
  }, { onConflict: 'workspace_id,lead_id,normalized_email' })
  if (result.error) throw new Error('Unable to prepare unsubscribe protection')
  return token
}

export async function recordRecipientUnsubscribe(service: UnsafeDb, token: string): Promise<'recorded'|'already_recorded'|'invalid'> {
  if (!validOpaqueUnsubscribeToken(token)) return 'invalid'
  const hash = unsubscribeTokenHash(token)
  const found = await service.from('unsubscribe_tokens').select('id,workspace_id,lead_id,normalized_email,used_at').eq('token_hash', hash).maybeSingle()
  if (found.error || !found.data) return 'invalid'
  const row = found.data
  const existing = await service.from('outreach_suppressions').select('id').eq('workspace_id', row.workspace_id).eq('normalized_email', row.normalized_email).maybeSingle()
  if (existing.data) {
    if (!row.used_at) await service.from('unsubscribe_tokens').update({ used_at: new Date().toISOString() }).eq('id', row.id)
    return 'already_recorded'
  }
  const now = new Date().toISOString()
  const inserted = await service.from('outreach_suppressions').insert({ workspace_id: row.workspace_id, lead_id: row.lead_id, normalized_email: row.normalized_email, source: 'recipient_unsubscribe', token_hash: hash, suppressed_at: now, metadata: { source: 'unsubscribe_link' } })
  if (inserted.error && inserted.error.code !== '23505') throw new Error('Unable to record unsubscribe')
  await Promise.all([
    service.from('unsubscribe_tokens').update({ used_at: now }).eq('id', row.id),
    service.from('leads').update({ outreach_suppression_reason: 'recipient_unsubscribe', outreach_suppressed_at: now, updated_at: now }).eq('workspace_id', row.workspace_id).eq('id', row.lead_id),
    service.from('follow_ups').update({ status: 'cancelled' }).eq('workspace_id', row.workspace_id).eq('lead_id', row.lead_id).eq('status', 'scheduled'),
    service.from('activity_log').insert({ workspace_id: row.workspace_id, lead_id: row.lead_id, event_type: 'recipient_unsubscribe_recorded', description: 'Recipient unsubscribed from future outreach.', metadata: {} }),
  ])
  return inserted.error ? 'already_recorded' : 'recorded'
}

export async function recordManualDoNotContact(db: SupabaseClient<Database>, leadId: string, email: string, actorUserId: string): Promise<void> {
  const normalized = normalizeSuppressionEmail(email), now = new Date().toISOString()
  const unsafe = db as UnsafeDb
  const result = await unsafe.from('outreach_suppressions').upsert(workspaceRow(db, { lead_id: leadId, normalized_email: normalized, source: 'manual_do_not_contact', suppressed_at: now, created_by: actorUserId, metadata: {} }), { onConflict: 'workspace_id,normalized_email' })
  if (result.error) throw new Error(result.error.message)
  await Promise.all([
    db.from('leads').update({ outreach_suppression_reason: 'manual_do_not_contact', outreach_suppressed_at: now, updated_at: now }).eq('id', leadId),
    db.from('follow_ups').update({ status: 'cancelled' }).eq('lead_id', leadId).eq('status', 'scheduled'),
    db.from('activity_log').insert(workspaceRow(db, { lead_id: leadId, event_type: 'manual_do_not_contact_recorded', description: 'Future outreach disabled for this recipient.', metadata: {} })),
  ])
}
