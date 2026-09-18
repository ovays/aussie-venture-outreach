import type { SupabaseClient } from '@supabase/supabase-js'
import { isInitialEmailMode, type InitialEmailMode } from '@/lib/settingsDefaults'
import { isCanonicalLeadStatus } from '@/domain/decision-engine/transitions'
import {
  DEFAULT_DECISION_SCHEDULE,
  type DecisionEmailStage,
  type LeadDecisionContext,
} from '@/domain/decision-engine/types'
import type { DecisionContextLoadResult, DecisionContextLoaderOptions } from '@/domain/decision-engine'

const MAX_DECISION_CONTEXT_BATCH = 100

type DerivedClient = SupabaseClient<any, 'reachagent_prompt15_shadow'>
type LeadFact = {
  id: string
  updated_at: string
  status: string | null
  category_id: string | null
  source: string | null
  reactivation_sent_at: string | null
  has_email: boolean
  has_business_name: boolean
  has_category_name: boolean
  has_city: boolean
  has_website: boolean
  suppressed: boolean
  recipient_ownership: 'owned_by_lead' | 'owned_by_other' | 'unclaimed'
}
type EmailFact = {
  lead_id: string | null
  type: string
  status: string
  sent_at: string | null
  replied_at: string | null
  created_at: string
}
type TemplateFact = {
  category_id: string
  template_ready: boolean
  required_placeholders: string[]
}

function parseNonNegativeInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

function stageFromRows(rows: EmailFact[], type: string): DecisionEmailStage {
  const matching = rows.filter((row) => row.type === type)
  const delivered = matching.find((row) => !!row.sent_at)
  if (delivered?.sent_at) return { state: 'sent', sentAt: delivered.sent_at }
  if (matching.some((row) => row.status === 'email_sync_failed')) return { state: 'uncertain', sentAt: null }
  if (matching.some((row) => row.status === 'pending_send')) return { state: 'pending', sentAt: null }
  return { state: 'missing', sentAt: null }
}

function templateFacts(template: TemplateFact | undefined, lead: LeadFact): LeadDecisionContext['template'] {
  if (!template?.template_ready) return { available: false, requiredDataAvailable: false }
  const fieldAvailable: Readonly<Record<string, boolean>> = {
    business_name: lead.has_business_name,
    contact_name: false,
    category_name: lead.has_category_name,
    city: lead.has_city,
    website: lead.has_website,
  }
  return {
    available: true,
    requiredDataAvailable: template.required_placeholders.every((name) => fieldAvailable[name] === true),
  }
}

export async function selectDerivedShadowLeadIds(
  client: DerivedClient,
  selector: { leadIds?: readonly string[]; status?: string; limit?: number; recentDays?: number },
  now = new Date(),
): Promise<string[]> {
  if (selector.leadIds?.length) {
    const ids = [...new Set(selector.leadIds.map((id) => id.trim()).filter(Boolean))]
    if (ids.length > MAX_DECISION_CONTEXT_BATCH) throw new Error(`Shadow selection exceeds ${MAX_DECISION_CONTEXT_BATCH} leads.`)
    return ids
  }
  if (!selector.limit || !Number.isSafeInteger(selector.limit) || selector.limit < 1 || selector.limit > MAX_DECISION_CONTEXT_BATCH) {
    throw new Error(`Cohort shadow selection requires --limit between 1 and ${MAX_DECISION_CONTEXT_BATCH}.`)
  }
  if (!selector.status && !selector.recentDays) throw new Error('Unbounded shadow selection rejected: provide --lead-id, --status, or --recent-days.')
  if (selector.recentDays !== undefined && (!Number.isSafeInteger(selector.recentDays) || selector.recentDays < 1 || selector.recentDays > 365)) {
    throw new Error('--recent-days must be an integer between 1 and 365.')
  }
  let query = client.from('lead_facts').select('id')
  if (selector.status) query = query.eq('status', selector.status)
  if (selector.recentDays) query = query.gte('updated_at', new Date(now.getTime() - selector.recentDays * 86_400_000).toISOString())
  const selected = await query.order('updated_at', { ascending: false }).order('id', { ascending: true }).limit(selector.limit)
  if (selected.error) throw new Error(`Derived shadow sample selection failed: ${selected.error.message}`)
  return (selected.data ?? []).map((lead: { id: string }) => lead.id)
}

export async function loadDerivedDecisionContexts(
  client: DerivedClient,
  leadIds: readonly string[],
  options: DecisionContextLoaderOptions = {},
): Promise<DecisionContextLoadResult> {
  const ids = [...new Set(leadIds)]
  if (ids.length === 0) {
    return { contexts: [], missingLeadIds: [], metrics: { databaseCalls: 0, rowsFetched: 0, requestedLeadCount: 0, maxBatchSize: MAX_DECISION_CONTEXT_BATCH } }
  }
  if (ids.length > MAX_DECISION_CONTEXT_BATCH) throw new Error(`Decision context batch exceeds ${MAX_DECISION_CONTEXT_BATCH} leads`)

  const [leadResult, emailResult, settingResult, snapshotResult, duplicateResult, dealResult] = await Promise.all([
    client.from('lead_facts').select('*').in('id', ids).limit(ids.length),
    client.from('email_facts').select('*').in('lead_id', ids).order('created_at', { ascending: true }).limit(ids.length * 6),
    client.from('decision_settings').select('key,value').limit(8),
    client.from('mode_snapshots').select('lead_id,initial_email_mode,created_at').in('lead_id', ids).order('created_at', { ascending: false }).limit(ids.length * 10),
    client.from('duplicate_flags').select('lead_id').in('lead_id', ids).limit(ids.length),
    client.from('deal_leads').select('lead_id').in('lead_id', ids).limit(ids.length),
  ])
  for (const [label, result] of [
    ['lead facts', leadResult], ['email facts', emailResult], ['decision settings', settingResult],
    ['mode snapshots', snapshotResult], ['duplicate flags', duplicateResult], ['deal leads', dealResult],
  ] as const) {
    if (result.error) throw new Error(`Derived decision context ${label} query failed: ${result.error.message}`)
  }

  const leads = (leadResult.data ?? []) as LeadFact[]
  const categoryIds = [...new Set(leads.map((lead) => lead.category_id).filter((id): id is string => !!id))]
  const templateResult = categoryIds.length
    ? await client.from('category_initial_template_facts').select('*').in('category_id', categoryIds).limit(categoryIds.length)
    : { data: [] as TemplateFact[], error: null }
  if (templateResult.error) throw new Error(`Derived decision context template facts query failed: ${templateResult.error.message}`)

  const emails = (emailResult.data ?? []) as EmailFact[]
  const settings = new Map<string, string>((settingResult.data ?? []).map((row: { key: string; value: string }) => [row.key, row.value]))
  const settingMode = settings.get('initial_email_mode')
  const configuredMode = options.initialEmailMode ?? (settingMode && isInitialEmailMode(settingMode) ? settingMode : 'ai_personalised')
  const snapshots = new Map<string, InitialEmailMode>()
  for (const row of snapshotResult.data ?? []) {
    if (!row.lead_id || snapshots.has(row.lead_id) || !isInitialEmailMode(row.initial_email_mode)) continue
    snapshots.set(row.lead_id, row.initial_email_mode)
  }
  const duplicateIds = new Set((duplicateResult.data ?? []).map((row: { lead_id: string }) => row.lead_id))
  const dealIds = new Set((dealResult.data ?? []).map((row: { lead_id: string }) => row.lead_id))
  const templates = new Map((templateResult.data ?? []).map((row: TemplateFact) => [row.category_id, row]))
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
    const initialEmail = stageFromRows(leadEmails, 'initial_pitch')
    return {
      leadId: lead.id,
      status: lead.status,
      email: lead.has_email ? 'redacted@shadow.invalid' : null,
      duplicate: duplicateIds.has(lead.id),
      suppressed: lead.suppressed,
      dealState: dealIds.has(lead.id) || lead.status === 'closed' || lead.status === 'closed_manual' ? 'closed' : 'none',
      initialEmailMode: snapshots.get(lead.id) ?? configuredMode,
      research: {
        contactDiscoveryComplete: lead.has_email || lead.status !== 'new',
        personalisationComplete: lead.status !== 'new',
        canSupplyTemplateFields: false,
      },
      template: templateFacts(lead.category_id ? templates.get(lead.category_id) : undefined, lead),
      initialEmail,
      followUps: {
        followUp1: stageFromRows(leadEmails, 'follow_up_1'),
        followUp2: stageFromRows(leadEmails, 'follow_up_2'),
        followUp3: stageFromRows(leadEmails, 'follow_up_3'),
      },
      reply: { received: leadEmails.some((email) => !!email.replied_at) || lead.status === 'replied', classification: null },
      reactivation: {
        enabled: settings.get('reactivation_enabled') === 'true',
        sentAt: lead.reactivation_sent_at ?? stageFromRows(leadEmails, 'reactivation').sentAt,
      },
      schedule,
      asOf,
      manualOverride: null,
      operationalFacts: {
        categoryIdPresent: !!lead.category_id,
        hasUsableCategoryContext: !!lead.category_id && templates.has(lead.category_id),
        manualSource: lead.source === 'manual',
        recipientOwnership: lead.recipient_ownership,
        openDuplicateFlag: duplicateIds.has(lead.id),
      },
    }
  })
  const foundIds = new Set(contexts.map((context) => context.leadId))
  const rowsFetched = leads.length + emails.length + (settingResult.data?.length ?? 0)
    + (snapshotResult.data?.length ?? 0) + (duplicateResult.data?.length ?? 0)
    + (dealResult.data?.length ?? 0) + (templateResult.data?.length ?? 0)
  return {
    contexts,
    missingLeadIds: ids.filter((id) => !foundIds.has(id)),
    metrics: { databaseCalls: 6 + (categoryIds.length ? 1 : 0), rowsFetched, requestedLeadCount: ids.length, maxBatchSize: MAX_DECISION_CONTEXT_BATCH },
  }
}
