import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { isApiWorkspaceError, requireApiWorkspaceUser } from '@/lib/api-workspace'
import { canEditCustomerLeadNotes, canEditCustomerLeadOutcome } from '@/lib/access-policy'
import { customerLeadStatus, formatCustomerActivity } from '@/lib/customer-lead'
import type { Json } from '@/types/database'
import { recordManualDoNotContact } from '@/lib/suppression'
import { writeAuditEvent } from '@/lib/audit/write'

const idSchema = z.string().uuid()
const mutationSchema = z.object({
  outcome: z.enum(['interested', 'not_interested']).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
  do_not_contact: z.literal(true).optional(),
}).strict().refine((value) => value.outcome !== undefined || value.notes !== undefined || value.do_not_contact, 'No supported update supplied')

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const access = await requireApiWorkspaceUser()
  if (isApiWorkspaceError(access)) return access
  const parsedId = idSchema.safeParse((await params).id)
  if (!parsedId.success) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { data: lead, error } = await access.supabase
    .from('leads')
    .select('id,business_name,category_name,city,suburb,email,phone,website,notes,status,customer_outcome,created_at,updated_at')
    .eq('id', parsedId.data)
    .maybeSingle()
  if (error || !lead) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const [{ data: emails }, { data: events }, { data: settings }, { data: suppression }] = await Promise.all([
    access.supabase.from('emails')
      .select('id,type,subject,status,sent_at,replied_at,created_at')
      .eq('lead_id', parsedId.data).order('created_at', { ascending: false }).limit(20),
    access.supabase.from('activity_log')
      .select('id,event_type,created_at')
      .eq('lead_id', parsedId.data).order('created_at', { ascending: false }).limit(30),
    access.supabase.from('workspace_settings')
      .select('key,value').in('key', ['reactivation_enabled', 'reactivation_delay_days']),
    (access.supabase as any).from('outreach_suppressions').select('source,suppressed_at').eq('normalized_email',(lead.email??'').trim().toLowerCase()).maybeSingle(),
  ])
  const activity = (events ?? []).flatMap((event) => {
    const formatted = formatCustomerActivity({ event_type: event.event_type, business_name: lead.business_name })
    return formatted ? [{ id: event.id, ...formatted, created_at: event.created_at }] : []
  })
  const lastContact = (emails ?? []).find((email) => email.sent_at)?.sent_at ?? null
  const latestReply = (emails ?? []).find((email) => email.replied_at)
  const settingMap = new Map((settings ?? []).map((setting) => [setting.key, setting.value]))
  const initialSentAt = (emails ?? []).filter((email) => email.type === 'initial_pitch' && email.sent_at)
    .sort((a, b) => String(a.sent_at).localeCompare(String(b.sent_at)))[0]?.sent_at
  const followupsSent = ['follow_up_1', 'follow_up_2', 'follow_up_3'].every((type) =>
    (emails ?? []).some((email) => email.type === type && email.sent_at))
  const reactivationDelay = Number.parseInt(settingMap.get('reactivation_delay_days') ?? '90', 10)
  const reactivationDue = lead.status === 'contacted' && settingMap.get('reactivation_enabled') === 'true'
    && followupsSent && Boolean(initialSentAt)
    && Date.parse(initialSentAt ?? '') + reactivationDelay * 86_400_000 <= Date.now()

  return NextResponse.json({
    data: {
      id: lead.id,
      business_name: lead.business_name,
      category_name: lead.category_name,
      location: [lead.suburb, lead.city].filter(Boolean).join(', '),
      email: lead.email,
      phone: lead.phone,
      website: lead.website,
      notes: lead.notes,
      customer_outcome: lead.customer_outcome,
      status: customerLeadStatus({ status: lead.status, customer_outcome: lead.customer_outcome, reactivation_due: reactivationDue }),
      last_contact_at: lastContact,
      latest_reply: latestReply ? { subject: latestReply.subject, replied_at: latestReply.replied_at } : null,
      suppression: suppression ? { label: suppression.source === 'recipient_unsubscribe' ? 'Unsubscribed' : 'Do not contact', suppressed_at: suppression.suppressed_at } : null,
      activity,
      capabilities: {
        edit_notes: canEditCustomerLeadNotes(access.workspace.role, access.workspace.isPlatformAdmin),
        edit_outcome: canEditCustomerLeadOutcome(access.workspace.role, access.workspace.isPlatformAdmin),
        do_not_contact: access.workspace.role === 'owner' || access.workspace.role === 'admin',
      },
    },
  })
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const access = await requireApiWorkspaceUser()
  if (isApiWorkspaceError(access)) return access
  const parsedId = idSchema.safeParse((await params).id)
  if (!parsedId.success) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const parsed = mutationSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Only outcome and notes may be changed' }, { status: 400 })

  if (parsed.data.outcome !== undefined && !canEditCustomerLeadOutcome(access.workspace.role, access.workspace.isPlatformAdmin)) {
    return NextResponse.json({ error: 'Workspace admin access is required to change an outcome' }, { status: 403 })
  }
  if (parsed.data.notes !== undefined && !canEditCustomerLeadNotes(access.workspace.role, access.workspace.isPlatformAdmin)) {
    return NextResponse.json({ error: 'Notes access denied' }, { status: 403 })
  }
  if (parsed.data.do_not_contact && access.workspace.role !== 'owner' && access.workspace.role !== 'admin') {
    return NextResponse.json({ error: 'Workspace owner or admin access is required' }, { status: 403 })
  }

  const { data: existing } = await access.supabase.from('leads')
    .select('id,business_name,email,customer_outcome').eq('id', parsedId.data).maybeSingle()
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (parsed.data.do_not_contact) {
    if (!existing.email) return NextResponse.json({ error: 'This lead has no email address to suppress' }, { status: 400 })
    await recordManualDoNotContact(access.supabase, parsedId.data, existing.email, access.auth.user.id)
    await writeAuditEvent({ workspaceId: access.workspace.workspaceId, actorUserId: access.auth.user.id, actorRole: access.workspace.role, action: 'compliance.do_not_contact_recorded', targetType: 'lead', targetId: parsedId.data, metadata: {} })
  }

  const updates: { customer_outcome?: 'interested' | 'not_interested' | null; notes?: string | null; updated_at: string } = {
    updated_at: new Date().toISOString(),
  }
  if (parsed.data.outcome !== undefined) updates.customer_outcome = parsed.data.outcome
  if (parsed.data.notes !== undefined) updates.notes = parsed.data.notes?.trim() || null
  const { error } = await access.supabase.from('leads').update(updates).eq('id', parsedId.data)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const activityRows: Array<{ event_type: string; lead_id: string; workspace_id: string; description: string; metadata: Json }> = []
  if (parsed.data.outcome !== undefined && parsed.data.outcome !== existing.customer_outcome) {
    const eventType = parsed.data.outcome ? `customer_outcome_${parsed.data.outcome}` : 'customer_outcome_cleared'
    activityRows.push({ event_type: eventType, lead_id: parsedId.data, workspace_id: access.workspace.workspaceId, description: 'Customer business outcome updated.', metadata: {} })
  }
  if (parsed.data.notes !== undefined) {
    activityRows.push({ event_type: 'customer_notes_updated', lead_id: parsedId.data, workspace_id: access.workspace.workspaceId, description: 'Customer notes updated.', metadata: {} })
  }
  if (activityRows.length) await access.supabase.from('activity_log').insert(activityRows)
  return NextResponse.json({ success: true })
}
