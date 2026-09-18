import type { SupabaseClient } from '@supabase/supabase-js'
import { getInitialTemplateReadiness } from '@/lib/category-email-templates'
import { isDeliverySuppressedForAddress } from '@/lib/delivery-suppression'
import { isInitialEmailMode, type InitialEmailMode } from '@/lib/settingsDefaults'
import type { Database } from '@/types/database'
import { isCanonicalLeadStatus } from './transitions'
import { DEFAULT_DECISION_SCHEDULE, type DecisionEmailStage, type LeadDecisionContext } from './types'

const MAX_DECISION_CONTEXT_BATCH = 100
const INITIAL_EMAIL_MODE_SNAPSHOT_EVENT = 'initial_email_mode_snapshot'
const TEMPLATE_PLACEHOLDER = /{{([a-z][a-z0-9_]*)}}/g

type V2Client = SupabaseClient<Database>
type LeadRow = Pick<Database['public']['Tables']['leads']['Row'],
  'id' | 'business_name' | 'category_id' | 'category_name' | 'city' | 'website' | 'email' | 'normalized_email' | 'source' | 'status'
  | 'delivery_suppressed_emails' | 'outreach_suppressed_at' | 'outreach_suppression_reason' | 'reactivation_sent_at'>
type LoadedLeadRow = LeadRow & {
  deals: { lead_id: string | null }[] | null
  categories: { category_email_templates: TemplateRow[] | null } | null
}
type EmailRow = Pick<Database['public']['Tables']['emails']['Row'], 'lead_id' | 'type' | 'status' | 'sent_at' | 'replied_at' | 'created_at'>
type TemplateRow = Pick<Database['public']['Tables']['category_email_templates']['Row'], 'category_id' | 'template_type' | 'subject_template' | 'body_template'>

export interface DecisionContextLoadResult {
  contexts: LeadDecisionContext[]
  missingLeadIds: string[]
  metrics: { databaseCalls: number; rowsFetched: number; requestedLeadCount: number; maxBatchSize: number }
}

export interface DecisionContextLoaderOptions {
  asOf?: string
  initialEmailMode?: InitialEmailMode
}

function parseNonNegativeInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

function stageFromRows(rows: EmailRow[], type: string): DecisionEmailStage {
  const matching = rows.filter((row) => row.type === type)
  const delivered = matching.find((row) => !!row.sent_at)
  if (delivered?.sent_at) return { state: 'sent', sentAt: delivered.sent_at }
  if (matching.some((row) => row.status === 'email_sync_failed')) return { state: 'uncertain', sentAt: null }
  if (matching.some((row) => row.status === 'pending_send')) return { state: 'pending', sentAt: null }
  return { state: 'missing', sentAt: null }
}

function templateFacts(template: TemplateRow | undefined, lead: LeadRow): LeadDecisionContext['template'] {
  if (!template) return { available: false, requiredDataAvailable: false }
  const readiness = getInitialTemplateReadiness({
    template_type: 'initial_pitch', subject_template: template.subject_template, body_template: template.body_template,
  })
  if (!readiness.ready) return { available: false, requiredDataAvailable: false }
  const values: Readonly<Record<string, string | null>> = {
    business_name: lead.business_name, contact_name: null, category_name: lead.category_name,
    city: lead.city, website: lead.website,
  }
  const used = new Set<string>()
  for (const source of [template.subject_template ?? '', template.body_template ?? '']) {
    for (const match of source.matchAll(TEMPLATE_PLACEHOLDER)) used.add(match[1])
  }
  return { available: true, requiredDataAvailable: [...used].every((name) => !!values[name]?.trim()) }
}

function deliverySuppressed(lead: LeadRow): boolean {
  return !!lead.outreach_suppressed_at || !!lead.outreach_suppression_reason
    || isDeliverySuppressedForAddress(lead.email, lead.delivery_suppressed_emails)
}

export async function loadDecisionContexts(
  supabase: V2Client,
  leadIds: readonly string[],
  options: DecisionContextLoaderOptions = {},
): Promise<DecisionContextLoadResult> {
  const ids = [...new Set(leadIds)]
  if (ids.length === 0) {
    return { contexts: [], missingLeadIds: [], metrics: { databaseCalls: 0, rowsFetched: 0, requestedLeadCount: 0, maxBatchSize: MAX_DECISION_CONTEXT_BATCH } }
  }
  if (ids.length > MAX_DECISION_CONTEXT_BATCH) throw new Error(`Decision context batch exceeds ${MAX_DECISION_CONTEXT_BATCH} leads`)

  const [leadResult, emailResult, settingResult, snapshotResult, qualityResult] = await Promise.all([
    supabase.from('leads').select('id,business_name,category_id,category_name,city,website,email,normalized_email,source,status,delivery_suppressed_emails,outreach_suppressed_at,outreach_suppression_reason,reactivation_sent_at,deals(lead_id),categories!leads_category_id_fkey(category_email_templates(category_id,template_type,subject_template,body_template))').in('id', ids).limit(ids.length),
    supabase.from('emails').select('lead_id,type,status,sent_at,replied_at,created_at').in('lead_id', ids).in('type', ['initial_pitch', 'follow_up_1', 'follow_up_2', 'follow_up_3', 'reactivation']).in('status', ['pending_send', 'sent', 'email_sync_failed']).order('created_at', { ascending: true }).limit(ids.length * 6),
    supabase.from('settings').select('key,value').in('key', ['initial_email_mode', 'follow_up_1_days', 'follow_up_2_days', 'follow_up_3_days', 'dead_lead_days', 'reactivation_enabled', 'reactivation_delay_days', 'dead_after_reactivation_days']).limit(8),
    supabase.from('activity_log').select('lead_id,metadata,created_at').in('lead_id', ids).eq('event_type', INITIAL_EMAIL_MODE_SNAPSHOT_EVENT).order('created_at', { ascending: false }).limit(ids.length * 10),
    supabase.from('lead_data_quality_flags').select('lead_id,issue_type').in('lead_id', ids).eq('status', 'open').eq('issue_type', 'duplicate_lead').limit(ids.length * 10),
  ])
  for (const [label, query] of [['leads', leadResult], ['emails', emailResult], ['settings', settingResult], ['mode snapshots', snapshotResult], ['quality flags', qualityResult]] as const) {
    if (query.error) throw new Error(`Decision context ${label} query failed: ${query.error.message}`)
  }

  const leads = (leadResult.data ?? []) as unknown as LoadedLeadRow[]
  const emails = (emailResult.data ?? []) as EmailRow[]
  const settings = new Map((settingResult.data ?? []).map((row) => [row.key, row.value]))
  const settingMode = settings.get('initial_email_mode')
  const configuredMode = options.initialEmailMode ?? (settingMode && isInitialEmailMode(settingMode) ? settingMode : 'ai_personalised')
  const modeSnapshots = new Map<string, InitialEmailMode>()
  for (const row of snapshotResult.data ?? []) {
    if (!row.lead_id || modeSnapshots.has(row.lead_id)) continue
    const metadata = row.metadata as { initial_email_mode?: unknown } | null
    if (typeof metadata?.initial_email_mode === 'string' && isInitialEmailMode(metadata.initial_email_mode)) {
      modeSnapshots.set(row.lead_id, metadata.initial_email_mode)
    }
  }
  const templates = new Map(leads.flatMap((lead) => lead.categories?.category_email_templates ?? [])
    .filter((template) => template.template_type === 'initial_pitch').map((template) => [template.category_id, template]))
  const dealLeadIds = new Set(leads.filter((lead) => (lead.deals?.length ?? 0) > 0).map((lead) => lead.id))
  const duplicateLeadIds = new Set((qualityResult.data ?? []).map((flag) => flag.lead_id))
  const normalizedEmails = [...new Set(leads.map((lead) => lead.normalized_email).filter((email): email is string => !!email))]
  const ownershipResult = normalizedEmails.length
    ? await supabase.from('recipient_outreach_ownership').select('normalized_email,owner_lead_id').in('normalized_email', normalizedEmails).limit(normalizedEmails.length)
    : { data: [] as { normalized_email: string; owner_lead_id: string | null }[], error: null }
  if (ownershipResult.error) throw new Error(`Decision context recipient ownership query failed: ${ownershipResult.error.message}`)
  const ownership = new Map((ownershipResult.data ?? []).map((row) => [row.normalized_email, row.owner_lead_id]))
  const schedule: LeadDecisionContext['schedule'] = {
    followUp1Days: parseNonNegativeInteger(settings.get('follow_up_1_days'), DEFAULT_DECISION_SCHEDULE.followUp1Days),
    followUp2Days: parseNonNegativeInteger(settings.get('follow_up_2_days'), DEFAULT_DECISION_SCHEDULE.followUp2Days),
    followUp3Days: parseNonNegativeInteger(settings.get('follow_up_3_days'), DEFAULT_DECISION_SCHEDULE.followUp3Days),
    deadLeadDays: parseNonNegativeInteger(settings.get('dead_lead_days'), DEFAULT_DECISION_SCHEDULE.deadLeadDays),
    reactivationDelayDays: parseNonNegativeInteger(settings.get('reactivation_delay_days'), DEFAULT_DECISION_SCHEDULE.reactivationDelayDays),
    deadAfterReactivationDays: parseNonNegativeInteger(settings.get('dead_after_reactivation_days'), DEFAULT_DECISION_SCHEDULE.deadAfterReactivationDays),
  }
  const asOf = options.asOf ?? new Date().toISOString()

  const contexts = leads.map((lead): LeadDecisionContext => {
    if (!lead.status || !isCanonicalLeadStatus(lead.status)) throw new Error(`Lead ${lead.id} has non-canonical status ${lead.status ?? 'null'}`)
    const leadEmails = emails.filter((email) => email.lead_id === lead.id)
    const template = templateFacts(lead.category_id ? templates.get(lead.category_id) : undefined, lead)
    return {
      leadId: lead.id, status: lead.status, email: lead.email, duplicate: duplicateLeadIds.has(lead.id),
      suppressed: deliverySuppressed(lead),
      dealState: dealLeadIds.has(lead.id) || lead.status === 'closed' || lead.status === 'closed_manual' ? 'closed' : 'none',
      initialEmailMode: modeSnapshots.get(lead.id) ?? configuredMode,
      research: { contactDiscoveryComplete: !!lead.email || lead.status !== 'new', personalisationComplete: lead.status !== 'new', canSupplyTemplateFields: false },
      template,
      initialEmail: stageFromRows(leadEmails, 'initial_pitch'),
      followUps: { followUp1: stageFromRows(leadEmails, 'follow_up_1'), followUp2: stageFromRows(leadEmails, 'follow_up_2'), followUp3: stageFromRows(leadEmails, 'follow_up_3') },
      reply: { received: leadEmails.some((email) => !!email.replied_at) || lead.status === 'replied', classification: null },
      reactivation: { enabled: settings.get('reactivation_enabled') === 'true', sentAt: lead.reactivation_sent_at ?? stageFromRows(leadEmails, 'reactivation').sentAt },
      schedule, asOf, manualOverride: null,
      operationalFacts: {
        categoryIdPresent: !!lead.category_id,
        hasUsableCategoryContext: !!lead.category_id && !!lead.categories,
        manualSource: lead.source === 'manual',
        recipientOwnership: !lead.normalized_email || !ownership.has(lead.normalized_email) ? 'unclaimed'
          : ownership.get(lead.normalized_email) === lead.id ? 'owned_by_lead' : 'owned_by_other',
        openDuplicateFlag: duplicateLeadIds.has(lead.id),
      },
    }
  })

  const foundIds = new Set(contexts.map((context) => context.leadId))
  const rowsFetched = leads.length + emails.length + (settingResult.data?.length ?? 0) + (snapshotResult.data?.length ?? 0)
    + leads.reduce((sum, lead) => sum + (lead.deals?.length ?? 0) + (lead.categories?.category_email_templates?.length ?? 0), 0)
    + (qualityResult.data?.length ?? 0) + (ownershipResult.data?.length ?? 0)
  return {
    contexts, missingLeadIds: ids.filter((id) => !foundIds.has(id)),
    metrics: { databaseCalls: 5 + (normalizedEmails.length ? 1 : 0), rowsFetched, requestedLeadCount: ids.length, maxBatchSize: MAX_DECISION_CONTEXT_BATCH },
  }
}

export async function loadDecisionContext(supabase: V2Client, leadId: string, options: DecisionContextLoaderOptions = {}): Promise<LeadDecisionContext | null> {
  return (await loadDecisionContexts(supabase, [leadId], options)).contexts[0] ?? null
}

export { MAX_DECISION_CONTEXT_BATCH }
