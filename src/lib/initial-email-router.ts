import type { SupabaseClient } from '@supabase/supabase-js'
import { emailBodyToHtml, textToHtml } from '@/lib/utils'
import { acquireLock, releaseLock } from '@/lib/distributed-lock'
import { generateInitialEmailFromTemplate } from '@/lib/initial-email-template'
import { isInitialEmailMode, type InitialEmailMode } from '@/lib/settingsDefaults'

export type InitialEmailLead = {
  id: string; business_name: string; category_id: string | null; category_name: string | null
  suburb: string | null; city: string | null; website: string | null; description: string | null
  services: string | null; content_type: string | null; contact_name?: string | null
}
export type InitialEmailFailure = {
  leadId: string; businessName: string; categoryId: string | null; categoryName: string | null
  code: string; reason: string
}
export type InitialEmailResult =
  | { ok: true; mode: InitialEmailMode; outcome: 'created' | 'regenerated' | 'generated' | 'existing'; emailId?: string; subject?: string; body?: string; html?: string; generationSource?: 'ai' | 'template' }
  | { ok: false; mode: InitialEmailMode; error: InitialEmailFailure }

export async function readInitialEmailMode(supabase: SupabaseClient): Promise<InitialEmailMode> {
  const { data, error } = await supabase.from('settings').select('value').eq('key', 'initial_email_mode').maybeSingle()
  if (error) throw new Error(`Could not read Initial Email Mode: ${error.message}`)
  if (!data) return 'ai_personalised'
  if (!isInitialEmailMode(data.value)) throw new Error(`Invalid saved Initial Email Mode: ${String(data.value)}`)
  return data.value
}

function failure(lead: InitialEmailLead, mode: InitialEmailMode, code: string, reason: string, categoryName = lead.category_name): InitialEmailResult {
  return { ok: false, mode, error: { leadId: lead.id, businessName: lead.business_name, categoryId: lead.category_id, categoryName, code, reason } }
}

type AiInitialWriter = (params: { business_name: string; category: string; suburb: string; city: string; website: string; description: string; services: string; content_type: string }) => Promise<{ subject: string; body: string }>

const PLAIN_TEXT_SIGNOFF = `Cheers,
Owais
Aussie Venture

hello@aussieventure.com
https://aussieventure.com
Instagram: https://instagram.com/aussie.venture
TikTok: https://tiktok.com/@aussie.venture
Facebook: https://facebook.com/AussieVenture
Sydney Venture: https://facebook.com/Sydneyventure`

const HTML_SIGNOFF = `<div style="margin-top:24px;padding-top:16px;border-top:1px solid #e5e7eb;font-size:15px;">
  <p style="margin:0 0 2px;color:#374151;">Cheers,</p>
  <p style="margin:0 0 2px;font-weight:600;color:#111827;">Owais</p>
  <p style="margin:0 0 12px;color:#374151;">Aussie Venture</p>
  <p style="margin:0 0 3px;font-size:13px;"><a href="mailto:hello@aussieventure.com" style="color:#0ea5e9;text-decoration:none;">hello@aussieventure.com</a></p>
  <p style="margin:0 0 8px;font-size:13px;"><a href="https://aussieventure.com" style="color:#0ea5e9;text-decoration:none;">aussieventure.com</a></p>
  <p style="margin:0;font-size:13px;color:#6b7280;">
    <a href="https://instagram.com/aussie.venture" style="color:#0ea5e9;text-decoration:none;">Instagram</a>&nbsp;&middot;&nbsp;<a href="https://tiktok.com/@aussie.venture" style="color:#0ea5e9;text-decoration:none;">TikTok</a>&nbsp;&middot;&nbsp;<a href="https://facebook.com/AussieVenture" style="color:#0ea5e9;text-decoration:none;">Facebook</a>&nbsp;&middot;&nbsp;<a href="https://facebook.com/Sydneyventure" style="color:#0ea5e9;text-decoration:none;">Sydney Venture</a>
  </p>
</div>`

async function generateContent(supabase: SupabaseClient, lead: InitialEmailLead, mode: InitialEmailMode, aiWriter?: AiInitialWriter): Promise<InitialEmailResult> {
  if (mode === 'template') {
    const result = await generateInitialEmailFromTemplate(supabase, lead)
    if (!result.ok) return failure(lead, mode, result.code, result.reason, result.categoryName)
    return {
      ok: true,
      mode,
      outcome: 'generated',
      subject: result.subject,
      body: `${result.body}\n\n${PLAIN_TEXT_SIGNOFF}`,
      html: `${textToHtml(result.body)}\n${HTML_SIGNOFF}`,
      generationSource: 'template',
    }
  }
  const writer = aiWriter ?? (await import('@/ai/workflows')).writeOutreachEmail
  const result = await writer({
    business_name: lead.business_name, category: lead.category_name ?? '', suburb: lead.suburb ?? '', city: lead.city ?? '',
    website: lead.website ?? '', description: lead.description ?? '', services: lead.services ?? '', content_type: lead.content_type ?? 'remote',
  })
  return { ok: true, mode, outcome: 'generated', subject: result.subject, body: result.body, html: emailBodyToHtml(result.body), generationSource: 'ai' }
}

export async function routeInitialEmail(
  supabase: SupabaseClient,
  lead: InitialEmailLead,
  mode: InitialEmailMode,
  options: { operation?: 'normal' | 'regenerate' | 'content_only'; pendingEmailId?: string; aiWriter?: AiInitialWriter } = {},
): Promise<InitialEmailResult> {
  const operation = options.operation ?? 'normal'
  if (operation === 'content_only') return generateContent(supabase, lead, mode, options.aiWriter)
  const lockKey = `initial-email-generation:${lead.id}`
  const token = await acquireLock(supabase, lockKey)
  if (!token) return failure(lead, mode, 'generation_in_progress', 'Initial Email generation is already in progress for this lead.')
  try {
    const { data: pending, error: pendingError } = await supabase.from('emails').select('id').eq('lead_id', lead.id).eq('type', 'initial_pitch').eq('status', 'pending_send').limit(1).maybeSingle()
    if (pendingError) return failure(lead, mode, 'email_lookup_failed', pendingError.message)
    if (operation === 'normal' && pending) return { ok: true, mode, outcome: 'existing', emailId: pending.id }
    const targetId = options.pendingEmailId ?? pending?.id
    if (operation === 'regenerate' && !targetId) return failure(lead, mode, 'no_eligible_email', 'No pending Initial Email exists for regeneration.')

    const generated = await generateContent(supabase, lead, mode, options.aiWriter)
    if (!generated.ok) return generated
    const values = { subject: generated.subject!, body_text: generated.body!, body_html: generated.html!, generation_source: generated.generationSource!, edited_at: null, edited_by_user: false }
    if (operation === 'regenerate') {
      const { data, error } = await supabase.from('emails').update(values).eq('id', targetId!).eq('lead_id', lead.id).eq('type', 'initial_pitch').eq('status', 'pending_send').select('id').maybeSingle()
      if (error || !data) return failure(lead, mode, 'database_save_conflict', error?.message ?? 'The eligible email changed before it could be replaced.')
      return { ...generated, outcome: 'regenerated', emailId: data.id }
    }
    const { data, error } = await supabase.from('emails').insert({ lead_id: lead.id, type: 'initial_pitch', status: 'pending_send', ...values }).select('id').single()
    if (error) {
      if (error.code === '23505') return { ok: true, mode, outcome: 'existing' }
      return failure(lead, mode, 'database_save_conflict', error.message)
    }
    const { error: leadError } = await supabase.from('leads').update({ status: 'email_ready' }).eq('id', lead.id)
    if (leadError) {
      await supabase.from('emails').delete().eq('id', data.id).eq('lead_id', lead.id).eq('type', 'initial_pitch').eq('status', 'pending_send')
      return failure(lead, mode, 'lead_transition_failed', leadError.message)
    }
    return { ...generated, outcome: 'created', emailId: data.id }
  } finally {
    await releaseLock(supabase, lockKey, token)
  }
}
