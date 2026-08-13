import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { readInitialEmailMode, routeInitialEmail } from '@/lib/initial-email-router'
import { INITIAL_EMAIL_MODES } from '@/lib/settingsDefaults'

const schema = z.object({
  lead_ids: z.array(z.string().uuid()).min(1).max(200),
  mode: z.enum(INITIAL_EMAIL_MODES),
})

export async function GET(): Promise<NextResponse> {
  const supabase = await createClient()
  const mode = await readInitialEmailMode(supabase)
  return NextResponse.json({ mode })
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const parsed = schema.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  const supabase = await createClient()
  const mode = parsed.data.mode
  const failed: Array<{ lead_id: string; business_name: string; category_id: string | null; category_name: string | null; code: string; reason: string }> = []
  let regenerated = 0
  let skipped = 0

  for (const id of parsed.data.lead_ids) {
    try {
      const { data: lead } = await supabase.from('leads')
        .select('id, business_name, category_id, category_name, suburb, city, website, description, services, status, content_type')
        .eq('id', id).maybeSingle()
      if (!lead) { skipped++; failed.push({ lead_id: id, business_name: id, category_id: null, category_name: null, code: 'lead_not_found', reason: 'Lead not found.' }); continue }
      if (lead.status !== 'email_ready') { skipped++; failed.push({ lead_id: id, business_name: lead.business_name, category_id: lead.category_id, category_name: lead.category_name, code: 'ineligible_status', reason: 'Lead is not email_ready.' }); continue }
      const { data: pending } = await supabase.from('emails').select('id').eq('lead_id', id).eq('type', 'initial_pitch').eq('status', 'pending_send').limit(1).maybeSingle()
      if (!pending) { skipped++; failed.push({ lead_id: id, business_name: lead.business_name, category_id: lead.category_id, category_name: lead.category_name, code: 'no_eligible_email', reason: 'No pending Initial Email exists.' }); continue }
      const result = await routeInitialEmail(supabase, lead, mode, { operation: 'regenerate', pendingEmailId: pending.id })
      if (result.ok) regenerated++
      else failed.push({ lead_id: result.error.leadId, business_name: result.error.businessName, category_id: result.error.categoryId, category_name: result.error.categoryName, code: result.error.code, reason: result.error.reason })
    } catch (error) {
      failed.push({
        lead_id: id, business_name: id, category_id: null, category_name: null,
        code: 'generation_failed', reason: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return NextResponse.json({ mode, requested: parsed.data.lead_ids.length, regenerated, failed_count: failed.length, skipped, failed })
}
