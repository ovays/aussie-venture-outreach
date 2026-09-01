import { NextRequest, NextResponse } from 'next/server'
import { isAuthErrorResponse, requireApiAdmin } from '@/lib/auth'
import { dataQualityActionSchema, friendlyDataQualityError } from '@/lib/data-quality-actions'
import { deleteLeads } from '@/lib/delete-leads'
import { createServiceClient } from '@/lib/supabase/server'

const POSITIVE_STATUSES = new Set(['replied', 'negotiating', 'interested', 'closed', 'closed_won', 'closed_manual'])

export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = await requireApiAdmin()
  if (isAuthErrorResponse(auth)) return auth

  const parsed = dataQualityActionSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid Data Quality action request.' }, { status: 400 })
  const action = parsed.data
  const supabase = createServiceClient()

  try {
    if (action.action === 'resolve' || action.action === 'reopen') {
      const { data, error } = await supabase.rpc('set_data_quality_flag_status', {
        p_issue_type: action.issue_type,
        p_normalized_email: action.normalized_email ?? null,
        p_lead_ids: action.lead_ids ?? null,
        p_status: action.action === 'resolve' ? 'resolved' : 'open',
        p_resolution_reason: action.action === 'resolve' ? action.reason ?? null : null,
        p_actor_id: auth.user.id,
      })
      if (error) throw error
      return NextResponse.json({ success: true, data })
    }

    if (action.action === 'remove_email') {
      const { data, error } = await supabase.rpc('remove_data_quality_emails', {
        p_lead_ids: action.lead_ids,
        p_actor_id: auth.user.id,
      })
      if (error) throw error
      return NextResponse.json({ success: true, data })
    }

    const { data: lead, error: leadError } = await supabase
      .from('leads')
      .select('id,business_name,email,normalized_email,status,notes')
      .eq('id', action.lead_id)
      .maybeSingle()
    if (leadError) throw leadError
    if (!lead) return NextResponse.json({ error: 'Lead not found.' }, { status: 404 })

    const [emails, deals, ownership, flags] = await Promise.all([
      supabase.from('emails').select('id,replied_at').eq('lead_id', lead.id).limit(1),
      supabase.from('deals').select('id').eq('lead_id', lead.id).limit(1),
      lead.normalized_email
        ? supabase.from('recipient_outreach_ownership').select('owner_lead_id,state').eq('normalized_email', lead.normalized_email).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      supabase.from('lead_data_quality_flags').select('issue_type').eq('lead_id', lead.id).eq('status', 'open'),
    ])
    const lookupError = emails.error ?? deals.error ?? ownership.error ?? flags.error
    if (lookupError) throw lookupError
    const isOwner = ownership.data?.state === 'active' && ownership.data.owner_lead_id === lead.id
    const protectionReasons = [
      (emails.data?.length ?? 0) > 0 ? 'Has email history' : null,
      emails.data?.some((email) => !!email.replied_at) ? 'Has reply' : null,
      (deals.data?.length ?? 0) > 0 ? 'Has deal' : null,
      typeof lead.notes === 'string' && lead.notes.trim() ? 'Has notes' : null,
      POSITIVE_STATUSES.has(lead.status) ? 'Active/positive lifecycle' : null,
    ].filter((reason): reason is string => !!reason)

    if (isOwner || (protectionReasons.length > 0 && !action.confirm_protected)) {
      await supabase.from('activity_log').insert({
        event_type: 'data_quality_delete_blocked', lead_id: lead.id,
        description: 'Data Quality lead deletion was blocked by a safety check.',
        metadata: {
          actor_id: auth.user.id,
          issue_types: (flags.data ?? []).map((flag) => flag.issue_type),
          normalized_email: lead.normalized_email,
          ownership_conflict: isOwner,
          protection_reasons: protectionReasons,
        },
      })
      return NextResponse.json({
        error: isOwner
          ? 'This lead owns the active recipient outreach lifecycle. Resolve or transfer ownership before deleting it.'
          : 'This lead is protected. Review every warning and explicitly confirm protected deletion.',
        code: isOwner ? 'ownership_conflict' : 'protected_confirmation_required',
        protection_reasons: protectionReasons,
      }, { status: 409 })
    }

    const { error: auditError } = await supabase.from('activity_log').insert({
      event_type: 'data_quality_lead_deleted', lead_id: lead.id,
      description: 'Lead deleted from Data Quality by an admin.',
      metadata: {
        actor_id: auth.user.id,
        issue_types: (flags.data ?? []).map((flag) => flag.issue_type),
        normalized_email: lead.normalized_email,
        protected_confirmation: action.confirm_protected === true,
      },
    })
    if (auditError) throw auditError
    const result = await deleteLeads(supabase, [lead.id])
    if (result.deleted !== 1) throw new Error('Lead deletion did not complete')
    return NextResponse.json({ success: true, data: result })
  } catch (error) {
    console.error('Data Quality action failed', { action: action.action, userId: auth.user.id, error })
    return NextResponse.json({ error: friendlyDataQualityError(error) }, { status: 409 })
  }
}
