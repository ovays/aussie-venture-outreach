/**
 * DESTRUCTIVE LOCAL INTEGRATION TEST — DO NOT RUN AGAINST SHARED OR REMOTE DATA.
 *
 * This script deletes and recreates follow-up fixture email data, changes fixture
 * timestamps, and invokes the follow-up agent. Its safety guard must run before
 * any Supabase access or agent invocation.
 */
import { config } from 'dotenv'
config({ path: '.env.local' })

import { createServiceClient } from '@/lib/supabase/server'
import { runFollowUpAgent, type FollowUpEmailSender } from '../agents/followup'

const TEST_LEAD_NAME = 'Test Followup Lead'
const LOCAL_SUPABASE_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1'])
let fakeDeliverySequence = 0

const sendTestEmail: FollowUpEmailSender = async () => {
  fakeDeliverySequence++
  const deliveryNumber = String(fakeDeliverySequence).padStart(3, '0')

  return {
    id: `test-followup-delivery-${deliveryNumber}`,
    messageId: `<test-followup-${deliveryNumber}@localhost>`,
  }
}

function assertDestructiveLocalTestIsAllowed(): void {
  const warning =
    'Refusing to run: this is a destructive local integration test that deletes/recreates fixture data and invokes the follow-up agent.'
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL

  let hostname: string | undefined
  try {
    hostname = supabaseUrl ? new URL(supabaseUrl).hostname : undefined
    if (hostname?.startsWith('[') && hostname.endsWith(']')) {
      hostname = hostname.slice(1, -1)
    }
  } catch {
    throw new Error(`${warning} NEXT_PUBLIC_SUPABASE_URL is missing or invalid.`)
  }

  if (!hostname || !LOCAL_SUPABASE_HOSTNAMES.has(hostname)) {
    throw new Error(
      `${warning} Supabase hostname must be exactly localhost, 127.0.0.1, or ::1.`
    )
  }

  if (process.env.ALLOW_DESTRUCTIVE_LIFECYCLE_TEST !== 'true') {
    throw new Error(`${warning} Set ALLOW_DESTRUCTIVE_LIFECYCLE_TEST=true to opt in.`)
  }

  if (process.env.RESEND_API_KEY?.trim()) {
    throw new Error(`${warning} RESEND_API_KEY must be unset so no real Resend key is available.`)
  }
}

function throwIfSupabaseError(operation: string, error: { message: string } | null): void {
  if (error) {
    throw new Error(`${operation} failed: ${error.message}`)
  }
}

async function main() {
  assertDestructiveLocalTestIsAllowed()

  const supabase = createServiceClient()

  console.log('====================================')
  console.log('FOLLOW-UP LIFECYCLE TEST')
  console.log('====================================')

  // Find test lead
  const { data: lead, error: leadSelectError } = await supabase
    .from('leads')
    .select('*')
    .eq('business_name', TEST_LEAD_NAME)
    .single()

  throwIfSupabaseError('Selecting test lead', leadSelectError)
  if (!lead) throw new Error('Test lead not found')

  console.log(`Using lead: ${lead.business_name}`)

  // Cleanup old emails
  const { error: cleanupError } = await supabase
    .from('emails')
    .delete()
    .eq('lead_id', lead.id)
  throwIfSupabaseError('Deleting old fixture emails', cleanupError)

  console.log('Old emails removed')

  // ============================================
  // STEP 1 — INITIAL EMAIL
  // ============================================

  const initialSentAt = new Date()

  const { error: initialInsertError } = await supabase.from('emails').insert({
    lead_id: lead.id,
    type: 'initial_pitch',
    subject: 'TEST Initial Email',
    body_html: '<p>TEST</p>',
    body_text: 'TEST',
    status: 'sent',
    sent_at: initialSentAt.toISOString(),
  })
  throwIfSupabaseError('Inserting initial fixture email', initialInsertError)

  console.log('STEP 1 COMPLETE → Initial email created')

  // ============================================
  // STEP 2 — FU1
  // ============================================

  const fu1Date = new Date()
  fu1Date.setDate(fu1Date.getDate() - 8)

  const { error: fu1UpdateError } = await supabase
    .from('emails')
    .update({
      sent_at: fu1Date.toISOString(),
    })
    .eq('lead_id', lead.id)
    .eq('type', 'initial_pitch')
  throwIfSupabaseError('Updating initial fixture email for FU1', fu1UpdateError)

  console.log('STEP 2 → Triggering FU1')

  await runFollowUpAgent(sendTestEmail)

  const { data: emailsAfterFU1, error: emailsAfterFU1Error } = await supabase
    .from('emails')
    .select('type, status, sent_at')
    .eq('lead_id', lead.id)
    .order('sent_at', { ascending: true })
  throwIfSupabaseError('Selecting emails after FU1', emailsAfterFU1Error)

  console.log('EMAILS AFTER FU1')
  console.table(emailsAfterFU1)

  // ============================================
  // STEP 3 — FU2
  // ============================================

  const fu2Date = new Date()
  fu2Date.setDate(fu2Date.getDate() - 15)

  const { error: fu2UpdateError } = await supabase
    .from('emails')
    .update({
      sent_at: fu2Date.toISOString(),
    })
    .eq('lead_id', lead.id)
    .eq('type', 'initial_pitch')
  throwIfSupabaseError('Updating initial fixture email for FU2', fu2UpdateError)

  console.log('STEP 3 → Triggering FU2')

  await runFollowUpAgent(sendTestEmail)

  const { data: emailsAfterFU2, error: emailsAfterFU2Error } = await supabase
    .from('emails')
    .select('type, status, sent_at')
    .eq('lead_id', lead.id)
    .order('sent_at', { ascending: true })
  throwIfSupabaseError('Selecting emails after FU2', emailsAfterFU2Error)

  console.log('EMAILS AFTER FU2')
  console.table(emailsAfterFU2)

  // ============================================
  // STEP 4 — FU3
  // ============================================

  const fu3Date = new Date()
  fu3Date.setDate(fu3Date.getDate() - 22)

  const { error: fu3UpdateError } = await supabase
    .from('emails')
    .update({
      sent_at: fu3Date.toISOString(),
    })
    .eq('lead_id', lead.id)
    .eq('type', 'initial_pitch')
  throwIfSupabaseError('Updating initial fixture email for FU3', fu3UpdateError)

  console.log('STEP 4 → Triggering FU3')

  await runFollowUpAgent(sendTestEmail)

  const { data: emailsAfterFU3, error: emailsAfterFU3Error } = await supabase
    .from('emails')
    .select('type, status, sent_at')
    .eq('lead_id', lead.id)
    .order('sent_at', { ascending: true })
  throwIfSupabaseError('Selecting emails after FU3', emailsAfterFU3Error)

  console.log('EMAILS AFTER FU3')
  console.table(emailsAfterFU3)

  console.log('====================================')
  console.log('TEST COMPLETE')
  console.log('====================================')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
