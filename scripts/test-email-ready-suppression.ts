import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { normalizeEmail } from '@/lib/data-quality'

const read = (file: string) => readFileSync(resolve(process.cwd(), file), 'utf8')

const router = read('src/lib/initial-email-router.ts')
const writer = read('agents/writer.ts')
const sender = read('agents/sender.ts')
const followup = read('agents/followup.ts')
const manualSentRoute = read('src/app/api/leads/[id]/mark-initial-sent/route.ts')
const migration = read('supabase/migrations/053_remove_suppressed_leads_from_email_ready.sql')
const dryRun = read('scripts/email-ready-suppression-cleanup-dry-run.sql')

const routerClaim = router.indexOf("claimRecipientOutreach(supabase, lead.id, 'initial')")
const routerInsert = router.indexOf("from('emails').insert", routerClaim)
const readyTransition = router.indexOf("update({ status: 'email_ready' })", routerInsert)
assert(routerClaim >= 0 && routerInsert > routerClaim && readyTransition > routerInsert,
  'recipient ownership is checked before a draft is inserted and email_ready is assigned')

const senderConflict = sender.indexOf('if (!ownership.allowed)')
const senderQueueRemoval = sender.indexOf('removeLeadFromInitialOutreachQueue', senderConflict)
const senderConflictContinue = sender.indexOf('continue', senderConflict)
assert(senderQueueRemoval > senderConflict && senderQueueRemoval < senderConflictContinue,
  'Sender persists queue removal before skipping an ownership conflict')

assert.match(sender, /INITIAL_EMAIL_SUPPRESSED_DELIVERY_FAILURE[\s\S]*?removeLeadFromInitialOutreachQueue\(supabase, emailRecord\.lead_id, 'suppressed'\)/,
  'Sender removes a terminally delivery-suppressed recipient from email_ready')
assert.match(followup, /claimRecipientOutreach\(supabase, candidate\.lead\.id, 'follow_up'\)[\s\S]*?if \(!ownership\.allowed\)[\s\S]*?return false/,
  'follow-up delivery remains blocked by authoritative ownership')
assert.match(manualSentRoute, /claimRecipientOutreach\(supabase, id, 'initial'\)[\s\S]*?if \(!ownership\.allowed\)[\s\S]*?status: 409/,
  'manually marking an Initial Email sent cannot bypass recipient ownership')

assert.match(migration, /pg_advisory_xact_lock\(hashtextextended\(v_email, 734921\)\)/,
  'ownership claims remain serialized by normalized recipient')
assert.match(migration, /status = CASE WHEN status = 'email_ready' THEN 'researched' ELSE status END/,
  'the ownership RPC atomically removes rejected leads from email_ready')
assert.match(migration, /UPDATE emails SET status = 'failed'[\s\S]*?type = 'initial_pitch'[\s\S]*?status = 'pending_send'/,
  'the ownership RPC atomically closes the rejected pending draft')
assert.match(writer, /eq\('status', 'researched'\)[\s\S]*?is\('outreach_suppressed_at', null\)[\s\S]*?is\('outreach_suppression_reason', null\)/,
  'scheduled Writer excludes suppressed researched leads in its database query')
assert.match(migration, /CREATE OR REPLACE FUNCTION public\.release_recipient_outreach_claim[\s\S]*?pg_advisory_xact_lock[\s\S]*?state = 'released'[\s\S]*?claim_token[\s\S]*?status IN \('pending_send','sent','email_sync_failed'\)/,
  'provisional ownership release is serialized, token-fenced, and guarded by outreach persisted after the claim')
assert.match(router, /from\('emails'\)\.insert[\s\S]*?releaseRecipientOutreachClaim\(supabase, lead\.id, ownership\.normalizedEmail, ownership\.claimToken\)/,
  'a failed email INSERT compensates its provisional ownership claim')
assert.match(migration, /clear_lead_outreach_suppression_on_email_change[\s\S]*?OLD\.email[\s\S]*?NEW\.email[\s\S]*?classify_email_quality\(NEW\.email\)[\s\S]*?outreach_suppression_reason = v_bad[\s\S]*?WHEN v_bad IS NULL THEN NULL/,
  'a genuinely corrected valid recipient clears stale suppression for re-evaluation while another invalid address remains suppressed')
assert.doesNotMatch(migration, /ALTER TABLE[\s\S]*status.*duplicate|ADD VALUE.*duplicate/i,
  'the fix introduces no duplicate lead lifecycle status')

assert.equal(normalizeEmail('  Owner@Example.COM  '), 'owner@example.com',
  'equivalent casing and surrounding whitespace use the canonical recipient key')
const dryRunStatements = dryRun.replace(/^--.*$/gm, '')
assert.doesNotMatch(dryRunStatements, /\b(?:UPDATE|DELETE|INSERT|MERGE|CALL)\b/i,
  'the cleanup dry run is read-only')

console.log('Email Ready recipient-suppression regression checks passed')
