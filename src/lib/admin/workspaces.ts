import 'server-only'

import { createServiceClient } from '@/lib/supabase/server'
import { getWorkspaceUsageOverview } from '@/lib/quota/service'
import type { AuditActorRole } from '@/lib/audit/types'

export interface WorkspaceDirectoryRow {
  id: string
  name: string
  slug: string
  status: string
  createdAt: string
  memberCount: number
  storedLeads: number
  mailboxCount: number
  planCode: string | null
  planName: string | null
  billingStatus: string | null
}

export interface WorkspaceDirectoryPage {
  data: WorkspaceDirectoryRow[]
  total: number
  page: number
  pageSize: number
  totalPages: number
}

function mapWorkspaceDirectoryRows(data: unknown): WorkspaceDirectoryRow[] {
  return (Array.isArray(data) ? data : []).map((row: Record<string, unknown>) => ({
    id: String(row.id ?? ''),
    name: String(row.name ?? ''),
    slug: String(row.slug ?? ''),
    status: String(row.status ?? ''),
    createdAt: String(row.created_at ?? ''),
    memberCount: Number(row.member_count ?? 0),
    storedLeads: Number(row.stored_leads ?? 0),
    mailboxCount: Number(row.mailbox_count ?? 0),
    planCode: row.plan_code === null ? null : String(row.plan_code ?? ''),
    planName: row.plan_name === null ? null : String(row.plan_name ?? ''),
    billingStatus: row.billing_status === null ? null : String(row.billing_status ?? ''),
  }))
}

export interface WorkspaceMemberRow {
  userId: string
  email: string | null
  fullName: string | null
  role: 'owner' | 'admin' | 'member'
  status: 'active' | 'invited' | 'suspended'
  createdAt: string
}

export interface WorkspaceAdminDetail {
  id: string
  name: string
  slug: string
  status: string
  plan: string
  createdAt: string
  members: WorkspaceMemberRow[]
  entitlement: { planCode: string; planName: string } | null
  billing: {
    subscriptionStatus: string
    currentPeriodEnd: string | null
    syncStatus: string | null
    planCode: string | null
  } | null
  usage: Awaited<ReturnType<typeof getWorkspaceUsageOverview>> | null
}

export async function adminListWorkspaceDirectory(): Promise<WorkspaceDirectoryRow[]> {
  const service = createServiceClient()
  const { data, error } = await service.rpc('admin_list_workspace_directory')
  if (error) throw new Error(error.message)
  return mapWorkspaceDirectoryRows(data)
}

export async function adminListWorkspaceDirectoryPage(input: {
  page: number
  pageSize: number
  search?: string
}): Promise<WorkspaceDirectoryPage> {
  const service = createServiceClient()
  const { data, error } = await service.rpc('admin_list_workspace_directory_page', {
    p_page: input.page,
    p_page_size: input.pageSize,
    p_search: input.search?.trim() ?? '',
  })
  if (error) throw new Error(error.message)
  const result = data && typeof data === 'object' ? data as Record<string, unknown> : {}
  const total = Number(result.total ?? 0) || 0
  const pageSize = Number(result.page_size ?? input.pageSize) || input.pageSize
  return {
    data: mapWorkspaceDirectoryRows(result.data),
    total,
    page: Number(result.page ?? input.page) || input.page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  }
}

export async function adminGetWorkspaceDetail(workspaceId: string): Promise<WorkspaceAdminDetail> {
  const service = createServiceClient()

  const [workspace, members, entitlement, billing, usage] = await Promise.all([
    service.from('workspaces').select('id, name, slug, status, plan, created_at').eq('id', workspaceId).maybeSingle(),
    service.from('workspace_members').select('user_id, role, status, created_at, profiles(email, full_name)').eq('workspace_id', workspaceId).order('created_at', { ascending: true }),
    service.from('workspace_entitlements').select('entitlement_profiles(plan_code, name)').eq('workspace_id', workspaceId).maybeSingle(),
    service.from('workspace_billing_accounts').select('subscription_status, current_period_end, sync_status, plan_code').eq('workspace_id', workspaceId).maybeSingle(),
    getWorkspaceUsageOverview(workspaceId).catch(() => null),
  ])

  if (workspace.error) throw new Error(workspace.error.message)
  if (!workspace.data) throw new Error('Workspace not found')
  if (members.error) throw new Error(members.error.message)

  const entitlementProfile = entitlement.data?.entitlement_profiles as unknown as { plan_code: string; name: string } | null | undefined
  const billingRow = billing.data as unknown as {
    subscription_status: string
    current_period_end: string | null
    sync_status: string | null
    plan_code: string | null
  } | null

  return {
    id: workspace.data.id,
    name: workspace.data.name,
    slug: workspace.data.slug,
    status: workspace.data.status,
    plan: workspace.data.plan,
    createdAt: workspace.data.created_at,
    members: (members.data ?? []).map((row) => {
      const profile = row.profiles as unknown as { email: string | null; full_name: string | null } | null | undefined
      return {
        userId: row.user_id,
        email: profile?.email ?? null,
        fullName: profile?.full_name ?? null,
        role: row.role,
        status: row.status,
        createdAt: row.created_at,
      }
    }),
    entitlement: entitlementProfile ? { planCode: entitlementProfile.plan_code, planName: entitlementProfile.name } : null,
    billing: billingRow ? {
      subscriptionStatus: billingRow.subscription_status,
      currentPeriodEnd: billingRow.current_period_end,
      syncStatus: billingRow.sync_status,
      planCode: billingRow.plan_code,
    } : null,
    usage,
  }
}

export async function adminSetWorkspaceStatus(
  workspaceId: string,
  status: 'active' | 'suspended' | 'archived',
  actorUserId: string,
  actorRole: AuditActorRole,
): Promise<void> {
  const service = createServiceClient()
  const { error } = await service.rpc('admin_set_workspace_status', {
    p_workspace_id: workspaceId,
    p_status: status,
    p_actor_id: actorUserId,
    p_actor_role: actorRole,
  })
  if (error) throw new Error(error.message)
}

export async function adminUpdateWorkspaceName(
  workspaceId: string,
  name: string,
  actorUserId: string,
  actorRole: AuditActorRole,
): Promise<void> {
  const service = createServiceClient()
  const { error } = await service.rpc('admin_update_workspace_name', {
    p_workspace_id: workspaceId,
    p_name: name,
    p_actor_id: actorUserId,
    p_actor_role: actorRole,
  })
  if (error) throw new Error(error.message)
}
