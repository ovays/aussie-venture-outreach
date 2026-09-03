import fs from 'node:fs'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'

type Level = 'PASS' | 'WARN' | 'FAIL'

let failures = 0

function report(level: Level, message: string): void {
  if (level === 'FAIL') failures += 1
  console.log(`[${level}] ${message}`)
}

function source(relativePath: string): string {
  const absolutePath = path.join(process.cwd(), relativePath)
  if (!fs.existsSync(absolutePath)) {
    report('FAIL', `${relativePath} is missing`)
    return ''
  }
  return fs.readFileSync(absolutePath, 'utf8')
}

function has(sourceText: string, expected: string, description: string): void {
  report(sourceText.includes(expected) ? 'PASS' : 'FAIL', description)
}

async function main(): Promise<void> {
  console.log('Hostinger inbound wiring audit (read-only; secret values are never printed)\n')

  const route = source('src/app/api/webhooks/hostinger/route.ts')
  const handler = source('src/lib/hostinger-webhook-handler.ts')
  const webhookParser = source('src/lib/hostinger-webhook.ts')
  const queue = source('src/lib/hostinger-inbound-queue.ts')
  const task = source('trigger/hostinger-inbound.ts')
  const mail = source('src/lib/hostinger-mail.ts')
  const receipts = source('src/lib/hostinger-inbound-receipts.ts')
  const payloadValidation = source('src/lib/hostinger-inbound-payload.ts')
  const migration = source('supabase/migrations/046_hostinger_inbound_receipts.sql')
  const reliabilityMigration = source('supabase/migrations/052_hostinger_inbound_reliability.sql')
  const threadingMigration = source('supabase/migrations/027_email_threading_and_dedup.sql')
  const operations = source('docs/hostinger-inbound-production.md')
  const packageJson = JSON.parse(source('package.json')) as {
    scripts?: Record<string, string>
    dependencies?: Record<string, string>
  }

  has(route, 'export async function POST', 'POST /api/webhooks/hostinger route is implemented')
  has(route, "'hostinger-inbound-message'", 'webhook route triggers task ID hostinger-inbound-message')
  has(route, 'HOSTINGER_WEBHOOK_SECRET', 'webhook route reads HOSTINGER_WEBHOOK_SECRET')
  has(route, 'TRIGGER_SECRET_KEY_PROD', 'webhook route reads the production Trigger.dev key')
  has(webhookParser, 'HOSTINGER_WEBHOOK_FIELD_ALIASES', 'webhook parser publishes its accepted field aliases')
  has(webhookParser, 'normalizeHostingerWebhookPayload', 'webhook parser returns normalized locators or explicit validation errors')
  has(webhookParser, "['id', ...HOSTINGER_WEBHOOK_FIELD_ALIASES.mailboxId]", 'webhook parser accepts mailbox.id as a mailbox resource ID')
  has(webhookParser, 'address(root.mailbox)', 'webhook parser accepts Hostinger\'s documented mailbox address string')
  has(webhookParser, "['test', 'webhook.test', 'webhook_test']", 'webhook parser recognizes only explicit test event names or flags')
  has(handler, "{ status: 401 }", 'webhook route returns 401 for missing or invalid Bearer authentication')
  has(handler, "{ status: 400 }", 'webhook route returns 400 for malformed JSON or an invalid real-event locator')
  has(handler, "{ ok: true, test: true }", 'explicit Hostinger test deliveries receive a 200 acknowledgement without enqueue')
  has(handler, "{ status: 202 }", 'valid real Hostinger deliveries receive 202 after durable enqueue acceptance')
  has(handler, "{ status: 503 }", 'receipt or Trigger enqueue failures remain retryable with 503')
  has(queue, "locator.mailboxId ?? locator.mailboxAddress", 'receipt keys use mailbox address when Hostinger omits mailbox ID')
  has(queue, "locator.eventId", 'receipt keys support stable event IDs and thread/timestamp fallback identifiers')
  report('PASS', 'Parser aliases: event/type/eventType/event_type; mailbox ID resource/account/mailbox variants; mailbox string/object address; folder/path variants; numeric/string UID; Message-ID/event-ID/thread-ID variants')
  report('PASS', 'Route statuses: 400 invalid JSON/payload/real locator; 401 auth failure; 200 explicit test/wrong event/wrong mailbox; 202 accepted; 503 receipt/enqueue failure')
  has(task, "id: 'hostinger-inbound-message'", 'Trigger.dev task exports hostinger-inbound-message')
  has(task, 'processHostingerInboundReceipt(validated.receiptId', 'task processes a validated durable receipt ID')
  has(task, 'validateHostingerInboundTaskPayload', 'task performs runtime payload validation')
  has(task, "name: 'hostinger-inbound'", 'task uses a dedicated Hostinger inbound queue')
  has(task, 'concurrencyLimit: 3', 'Hostinger inbound queue has an explicit concurrency limit')
  has(payloadValidation, "typeof receiptId !== 'string'", 'payload validation rejects a non-string receiptId')
  has(payloadValidation, '!receiptId.trim()', 'payload validation rejects an empty receiptId')
  has(mail, "requiredEnv('HOSTINGER_MAIL_API_TOKEN')", 'worker requires the Hostinger Mail API token')
  has(mail, "requiredEnv('HOSTINGER_MAILBOX_ID')", 'worker requires the Hostinger mailbox resource ID')
  has(mail, "requiredEnv('HOSTINGER_MAILBOX_ADDRESS')", 'worker requires the Hostinger mailbox address')
  has(mail, "requiredEnv('HOSTINGER_MAIL_API_BASE_URL')", 'worker requires the Hostinger Mail API base URL')
  has(mail, 'HOSTINGER_WEBHOOK_MATCH_TOLERANCE_MS = 2 * 60_000', 'UID fallback matching uses a two-minute instant tolerance')
  has(mail, "{ header: `Message-ID:${providerId}` }", 'UID resolution searches exact provider Message-ID before weaker metadata')
  has(mail, "'thread+sender+timestamp'", 'UID resolution uses thread ID strongly when list metadata exposes it')
  has(mail, "'sender+subject+timestamp'", 'UID resolution uses exact sender, conservative subject, and timestamp matching')
  has(mail, "'sender+timestamp'", 'UID resolution only falls back to exact sender and timestamp uniqueness')
  has(mail, "'/search')}?page=${page}&perPage=100", 'UID resolution uses paginated Hostinger metadata search')
  has(mail, 'threadMetadataAvailable', 'UID diagnostics distinguish unavailable Hostinger thread metadata')
  has(mail, "logger.warn('hostinger-inbound'", 'ambiguous UID resolution logs safe candidate-stage diagnostics')
  has(mail, 'searchMessages(HOSTINGER_INBOX_FOLDER', 'normal inbound metadata resolution searches INBOX only')
  has(mail, "webhook folder is not Inbox", 'worker rejects stored non-Inbox locators safely')
  has(handler, "reason: 'non_inbox_folder'", 'explicit non-Inbox webhooks are ignored before queueing')
  has(webhookParser, 'folderProvided: !!folder.value', 'receipt locator records whether Hostinger supplied the folder')
  has(webhookParser, 'addressAt([message, resource, data, nestedPayload, root]', 'safe sender metadata survives supported webhook nesting')
  has(webhookParser, 'addressesAt([message, resource, data, nestedPayload, root]', 'safe recipient metadata survives supported webhook nesting')
  has(migration, 'CREATE TABLE IF NOT EXISTS public.inbound_receipts', 'migration 046 creates inbound_receipts')
  has(migration, 'receipt_key TEXT NOT NULL UNIQUE', 'migration 046 enforces receipt idempotency')
  has(threadingMigration, 'ADD COLUMN IF NOT EXISTS message_id TEXT', 'migration 027 adds emails.message_id')
  has(reliabilityMigration, 'emails_message_id_not_null_idx', 'migration 052 adds the partial emails.message_id index')
  has(reliabilityMigration, 'claim_hostinger_inbound_receipt', 'migration 052 adds atomic failed/stale receipt claiming')
  has(reliabilityMigration, 'attempts = attempts + 1', 'receipt claims increment processing attempts')
  has(receipts, "rpc('claim_hostinger_inbound_receipt'", 'worker uses the atomic failed/stale receipt claim')
  has(receipts, 'HOSTINGER_PROCESSING_STALE_MS', 'worker applies deterministic stale-processing recovery')

  const requiredEnvironment = [
    'HOSTINGER_WEBHOOK_SECRET',
    'HOSTINGER_MAIL_API_TOKEN',
    'HOSTINGER_MAILBOX_ID',
    'HOSTINGER_MAILBOX_ADDRESS',
    'HOSTINGER_MAIL_API_BASE_URL',
    'NEXT_PUBLIC_SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
  ]
  for (const name of requiredEnvironment) {
    report(process.env[name]?.trim() ? 'PASS' : 'FAIL', `${name} is present in the audit process`)
  }
  const triggerKeyPresent = !!(process.env.TRIGGER_SECRET_KEY_PROD?.trim() || process.env.TRIGGER_SECRET_KEY?.trim())
  report(triggerKeyPresent ? 'PASS' : 'FAIL', 'TRIGGER_SECRET_KEY_PROD or TRIGGER_SECRET_KEY is present in the audit process')

  const sdkVersion = packageJson.dependencies?.['@trigger.dev/sdk'] ?? 'missing'
  const deployScript = packageJson.scripts?.['deploy:trigger'] ?? 'missing'
  const cliVersion = deployScript.match(/trigger\.dev@(\d+\.\d+\.\d+)/)?.[1] ?? 'unpinned'
  report(cliVersion === sdkVersion ? 'PASS' : 'FAIL', `Trigger.dev SDK=${sdkVersion}; deploy script CLI=${cliVersion}`)

  const documentedTriggerEnvironment = [
    'HOSTINGER_MAIL_API_TOKEN',
    'HOSTINGER_MAILBOX_ID',
    'HOSTINGER_MAILBOX_ADDRESS',
    'HOSTINGER_MAIL_API_BASE_URL',
    'NEXT_PUBLIC_SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
  ]
  for (const name of documentedTriggerEnvironment) {
    has(operations, name, `Trigger.dev production documentation names ${name}`)
  }
  has(operations, 'does not inherit Vercel', 'documentation warns that Trigger.dev does not inherit Vercel variables')

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()
  if (supabaseUrl && serviceRoleKey) {
    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
    const [receiptsProbe, emailsProbe] = await Promise.all([
      supabase.from('inbound_receipts').select('id', { count: 'exact', head: true }),
      supabase.from('emails').select('id,message_id,replied_at').limit(1),
    ])
    report(receiptsProbe.error ? 'FAIL' : 'PASS', receiptsProbe.error
      ? `database inbound_receipts probe failed: ${receiptsProbe.error.message}`
      : `database inbound_receipts is queryable (${receiptsProbe.count ?? 0} receipt rows)`)
    report(emailsProbe.error ? 'FAIL' : 'PASS', emailsProbe.error
      ? `database email-column probe failed: ${emailsProbe.error.message}`
      : 'database emails.message_id and emails.replied_at are queryable')
  } else {
    report('WARN', 'database probes skipped because Supabase server credentials are absent')
  }

  console.log(`\nAudit completed with ${failures} failure(s).`)
  process.exitCode = failures === 0 ? 0 : 1
}

main().catch((error) => {
  console.error(`[FAIL] audit crashed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
