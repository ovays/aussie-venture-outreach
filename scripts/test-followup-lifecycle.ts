import { config } from 'dotenv'
config({ path: '.env.local' })

import { createServiceClient } from '@/lib/supabase/server'
import { runFollowUpAgent } from '../agents/followup'

const TEST_LEAD_NAME = 'Test Followup Lead'

async function main() {
  const supabase = createServiceClient()

  console.log('====================================')
  console.log('FOLLOW-UP LIFECYCLE TEST')
  console.log('====================================')

  // Find test lead
  const { data: lead, error } = await supabase
    .from('leads')
    .select('*')
    .eq('business_name', TEST_LEAD_NAME)
    .single()

  if (error || !lead) {
    console.error('Test lead not found')
    console.error(error)
    return
  }

  console.log(`Using lead: ${lead.business_name}`)

  // Cleanup old emails
  await supabase
    .from('emails')
    .delete()
    .eq('lead_id', lead.id)

  console.log('Old emails removed')

  // ============================================
  // STEP 1 — INITIAL EMAIL
  // ============================================

  const initialSentAt = new Date()

  await supabase.from('emails').insert({
    lead_id: lead.id,
    type: 'initial_pitch',
    subject: 'TEST Initial Email',
    body_html: '<p>TEST</p>',
    body_text: 'TEST',
    status: 'sent',
    sent_at: initialSentAt.toISOString(),
  })

  console.log('STEP 1 COMPLETE → Initial email created')

  // ============================================
  // STEP 2 — FU1
  // ============================================

  const fu1Date = new Date()
  fu1Date.setDate(fu1Date.getDate() - 8)

  await supabase
    .from('emails')
    .update({
      sent_at: fu1Date.toISOString(),
    })
    .eq('lead_id', lead.id)
    .eq('type', 'initial_pitch')

  console.log('STEP 2 → Triggering FU1')

  await runFollowUpAgent()

  let { data: emailsAfterFU1 } = await supabase
    .from('emails')
    .select('type, status, sent_at')
    .eq('lead_id', lead.id)
    .order('sent_at', { ascending: true })

  console.log('EMAILS AFTER FU1')
  console.table(emailsAfterFU1)

  // ============================================
  // STEP 3 — FU2
  // ============================================

  const fu2Date = new Date()
  fu2Date.setDate(fu2Date.getDate() - 15)

  await supabase
    .from('emails')
    .update({
      sent_at: fu2Date.toISOString(),
    })
    .eq('lead_id', lead.id)
    .eq('type', 'initial_pitch')

  console.log('STEP 3 → Triggering FU2')

  await runFollowUpAgent()

  let { data: emailsAfterFU2 } = await supabase
    .from('emails')
    .select('type, status, sent_at')
    .eq('lead_id', lead.id)
    .order('sent_at', { ascending: true })

  console.log('EMAILS AFTER FU2')
  console.table(emailsAfterFU2)

  // ============================================
  // STEP 4 — FU3
  // ============================================

  const fu3Date = new Date()
  fu3Date.setDate(fu3Date.getDate() - 22)

  await supabase
    .from('emails')
    .update({
      sent_at: fu3Date.toISOString(),
    })
    .eq('lead_id', lead.id)
    .eq('type', 'initial_pitch')

  console.log('STEP 4 → Triggering FU3')

  await runFollowUpAgent()

  let { data: emailsAfterFU3 } = await supabase
    .from('emails')
    .select('type, status, sent_at')
    .eq('lead_id', lead.id)
    .order('sent_at', { ascending: true })

  console.log('EMAILS AFTER FU3')
  console.table(emailsAfterFU3)

  console.log('====================================')
  console.log('TEST COMPLETE')
  console.log('====================================')
}

main().catch(console.error)