import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const source = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8')
const resend = source('src/app/api/leads/[id]/resend/route.ts')
const bulk = source('src/app/api/leads/bulk/route.ts')
const sender = source('agents/sender.ts')
const recovery = source('src/lib/email-status.ts')
const followup = source('agents/followup.ts')
const reactivation = source('agents/reactivation.ts')

const contentOnly = resend.indexOf("operation: 'content_only'")
const sentInsert = resend.indexOf("status:     'sent'", contentOnly)
const recoveryInsert = resend.indexOf("status:     'email_sync_failed'", sentInsert)
assert.ok(contentOnly >= 0 && sentInsert > contentOnly && recoveryInsert > sentInsert)
assert.match(resend.slice(sentInsert, recoveryInsert), /generation_source: initialGenerationSource/, 'content-only Initial Email sent row stores the router source')
assert.match(resend.slice(recoveryInsert, recoveryInsert + 500), /generation_source: initialGenerationSource/, 'content-only Initial Email recovery row stores the router source')

assert.match(resend, /select\('id, subject, body_html, body_text, generation_source'\)/, 'manual send loads an existing pending source')
const existingUpdate = resend.slice(resend.indexOf("if (emailRowId)"), resend.indexOf("} else {", resend.indexOf("if (emailRowId)")))
assert.doesNotMatch(existingUpdate, /generation_source:\s*['"](?:ai|template)['"]/, 'sending an existing pending Initial Email never relabels its source')

assert.match(bulk, /select\('id, subject, body_html, body_text, generation_source'\)/, 'Bulk Send loads the router-created draft source')
const bulkSentUpdate = bulk.slice(bulk.indexOf("status: 'sent', resend_id"), bulk.indexOf('if (emailUpdateErr)'))
assert.doesNotMatch(bulkSentUpdate, /generation_source/, 'Bulk Send status update preserves the draft source')
assert.doesNotMatch(sender.match(/\.update\(\{[\s\S]*?status:\s*'sent'[\s\S]*?\}\)\.eq\('id', emailRecord\.id\)/)?.[0] ?? '', /generation_source/, 'automated Sender preserves the pending source')
assert.doesNotMatch(recovery.match(/status:\s*EMAIL_STATUS\.EMAIL_SYNC_FAILED[\s\S]*?\}\)\s*\.eq\('id', emailId\)/)?.[0] ?? '', /generation_source/, 'send-recovery status updates preserve existing source')

assert.doesNotMatch(followup, /generation_source/, 'follow-ups are not labelled as Initial Email AI/Template generation')
assert.doesNotMatch(reactivation, /generation_source/, 'Reactivation is not labelled as Initial Email AI/Template generation')
assert.doesNotMatch(recovery, /generation_source/, 'generic recovery helper does not invent a generation source for non-initial emails')

console.log('Initial Email generation_source send/resend/recovery checks passed')
