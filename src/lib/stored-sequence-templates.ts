import type { SupabaseClient } from '@supabase/supabase-js'
import { renderTemplate } from '@/lib/category-email-templates'
import { getReactivationFocus } from '@/lib/category-copy'
import { normalizeContentType } from '@/lib/content-type'
import { buildFollowUpEmail } from '@/lib/followup-email-templates'
import { textToHtml } from '@/lib/utils'
import { composeOutreachEmailBody, replaceExactTerminalSignOff } from '@/lib/outreach-signature'
import {
  brandIntroOptions,
  fu3ClosingFor,
  INITIAL_SIGN_OFF,
  FOLLOW_UP_SIGN_OFF,
  pickVariant,
  REACTIVATION_ASKS,
  reactivationContextFor,
  reactivationSubjectFor,
  reminderFor,
} from '@/lib/email-voice'
import type { FollowUpType } from '@/lib/followup-eligibility'
import { logger } from '@/lib/logger'

async function load(supabase: SupabaseClient, categoryId: string | null, type: FollowUpType | 'reactivation') {
  if (!categoryId) return null
  const { data, error } = await supabase.from('category_email_templates')
    .select('template_type, subject_template, body_template').eq('category_id', categoryId).eq('template_type', type).maybeSingle()
  return error ? null : data
}

export async function generateStoredFollowUp(
  supabase: SupabaseClient, categoryId: string | null, type: FollowUpType,
  businessName: string, initialSubject: string, category: string, contentType: string,
) {
  const fallback = buildFollowUpEmail(type, businessName, initialSubject, category, contentType)
  const row = await load(supabase, categoryId, type)
  if (row) {
    const rendered = renderTemplate({ template_type: type, subject_template: row.subject_template, body_template: row.body_template }, {
      business_name: businessName,
      initial_subject: initialSubject,
      category_reminder: reminderFor(category, businessName, type === 'follow_up_1' ? 'fu1' : type === 'follow_up_2' ? 'fu2' : 'fu3'),
      follow_up_3_closing: fu3ClosingFor(businessName),
    })
    if (rendered.ok && rendered.value.subject.trim() && rendered.value.body.trim()) {
      return { subject: rendered.value.subject.trim(), body: rendered.value.body.trim(), html: textToHtml(rendered.value.body.trim()), source: 'template' as const }
    }
  }
  logger.warn('followup', 'Stored category template unavailable or invalid; using hardcoded fallback', { category_id: categoryId, template_type: type })
  return { ...fallback, source: 'template' as const }
}

export async function generateStoredReactivation(
  supabase: SupabaseClient, categoryId: string | null, businessName: string, category: string, contentTypeValue: string,
) {
  const contentType = normalizeContentType(contentTypeValue)
  const subject = reactivationSubjectFor(businessName)
  const brandIntro = brandIntroOptions(contentType)[0]
  const context = reactivationContextFor(businessName, getReactivationFocus(category, contentType))
  const ask = pickVariant(REACTIVATION_ASKS, businessName, 'reactivation-ask')
  const body = `Hey ${businessName},\n\n${brandIntro}\n\nI emailed you about a collab a few months back and never heard anything. ${context}\n\n${ask}\n\n${FOLLOW_UP_SIGN_OFF}`
  const values = {
    business_name: businessName,
    reactivation_subject: subject,
    brand_intro: brandIntro,
    reactivation_context: context,
    reactivation_ask: ask,
  }
  const row = await load(supabase, categoryId, 'reactivation')
  if (row) {
    const rendered = renderTemplate({ template_type: 'reactivation', subject_template: row.subject_template, body_template: row.body_template }, values)
    if (rendered.ok && rendered.value.subject.trim() && rendered.value.body.trim()) {
      const normalised = replaceExactTerminalSignOff(rendered.value.body.trim(), INITIAL_SIGN_OFF, FOLLOW_UP_SIGN_OFF)
      const composed = composeOutreachEmailBody(normalised)
      return { subject: rendered.value.subject.trim(), body: composed.bodyText, html: composed.bodyHtml }
    }
  }
  logger.warn('reactivation', 'Stored category template unavailable or invalid; using hardcoded fallback', { category_id: categoryId, template_type: 'reactivation' })
  const composed = composeOutreachEmailBody(body)
  return { subject, body: composed.bodyText, html: composed.bodyHtml }
}
