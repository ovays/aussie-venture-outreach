import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { normalizeSuppressionEmail, unsubscribeTokenHash, validOpaqueUnsubscribeToken } from '../src/lib/suppression'
import { messageIdForMailbox } from '../src/lib/sender-identity'

const root=process.cwd(),read=(path:string)=>readFileSync(join(root,path),'utf8')
const inbox=read('src/lib/customer-inbox.ts'),inboxApi=read('src/app/api/customer-inbox/[id]/route.ts')
const migration=read('supabase-v2/migrations/00000000000022_customer_inbox_privacy_compliance.sql')
const sender=read('src/lib/mailbox/sender.ts'),page=read('src/app/dashboard/inbox/page.tsx')

assert(!page.includes('coming in the next phase'),'Inbox placeholder must be removed')
assert(inbox.includes('CUSTOMER_INBOX_PAGE_SIZE = 25')&&inbox.includes('CUSTOMER_INBOX_MESSAGE_LIMIT = 50'),'Inbox bounds required')
for(const raw of ['provider_message_key','resend_id','message_id','claimed_at','send_envelope']) assert(!inboxApi.includes(raw),`Inbox API leaked ${raw}`)
assert(inboxApi.includes('requireApiWorkspaceContentReader'),'Inbox detail must require content membership')
assert(migration.includes('USING (public.is_workspace_member(workspace_id));'),'Content RLS must exclude platform-admin-only access')
assert(migration.includes('outreach_suppressions')&&migration.includes('claim_outbound_email_for_send'),'Suppression must be checked by final claim')
assert(sender.includes('A connected workspace sending mailbox is required'),'Non-AV mailbox fallback must fail closed')
assert(sender.includes('assertCompleteSenderIdentity')&&sender.includes('ensureUnsubscribeToken'),'Sender identity and unsubscribe required at send boundary')
assert.equal(normalizeSuppressionEmail('  Person@Example.COM '),'person@example.com')
assert.equal(validOpaqueUnsubscribeToken('a'.repeat(43)),true)
assert.equal(validOpaqueUnsubscribeToken('a'.repeat(42)),false)
assert.equal(unsubscribeTokenHash('fixed'),unsubscribeTokenHash('fixed'),'Token hash must be deterministic for idempotency')
assert.equal(messageIdForMailbox('123','sender@customer.example'),'<123@customer.example>')
assert(!messageIdForMailbox('123','sender@customer.example').includes('aussieventure.com'),'Message-ID must use workspace mailbox domain')
assert(migration.includes("source IN ('recipient_unsubscribe', 'manual_do_not_contact')"),'Outcome and suppression must remain separate')
assert(migration.includes("UNIQUE (workspace_id, normalized_email)"),'Suppression must be workspace-scoped and idempotent')
assert(read('src/lib/customer-outreach.ts').includes('systemActive:false'),'Activation must remain disabled')
console.log('Prompt 6 customer Inbox/privacy/compliance tests passed')
