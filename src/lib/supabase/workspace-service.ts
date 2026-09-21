import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { createServiceClient } from './server'
import { registerWorkspaceServiceClient } from './workspace-scope'
export { workspaceIdForServiceClient, requireWorkspaceIdForServiceClient, workspaceRow, workspaceRows } from './workspace-scope'

export const WORKSPACE_TENANT_TABLES = [
  'activity_log',
  'ai_request_logs',
  'categories',
  'category_email_templates',
  'category_suburb_priorities',
  'category_suburb_search_state',
  'city_suburbs',
  'dead_letter_queue',
  'deals',
  'discovery_run_metrics',
  'distributed_locks',
  'dm_queue',
  'emails',
  'exhausted_queries',
  'follow_ups',
  'inbound_receipts',
  'lead_data_quality_flags',
  'leads',
  'recipient_outreach_ownership',
  'search_cache',
  'workflow_runs',
  'workflow_steps',
  'workspace_settings',
] as const

const tenantTables = new Set<string>(WORKSPACE_TENANT_TABLES)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
type Row = Record<string, unknown>

function withWorkspace(values: Row | readonly Row[], workspaceId: string): Row | Row[] {
  const rows = Array.isArray(values) ? values : [values]
  const scoped = rows.map((row) => {
    if (row.workspace_id !== undefined && row.workspace_id !== workspaceId) {
      throw new Error('Cross-workspace service-role write rejected')
    }
    return { ...row, workspace_id: workspaceId }
  })
  return Array.isArray(values) ? scoped : scoped[0]
}

/**
 * Service-role client that makes workspace ownership structural.
 *
 * Every tenant-table read/update/delete is filtered before callers can add
 * their own predicates, and inserts/upserts always carry workspace_id. Legacy
 * operational reads of `settings` are transparently routed to the per-workspace
 * settings table so one scoped client can be passed through existing services.
 */
export function createWorkspaceServiceClient(workspaceId: string): SupabaseClient<Database> {
  if (!UUID.test(workspaceId)) throw new Error('A valid workspaceId is required for operational database access')
  const client = createServiceClient() as SupabaseClient<Database>

  const scopedClient = new Proxy(client, {
    get(target, property, receiver) {
      if (property !== 'from') return Reflect.get(target, property, receiver)
      return (requestedTable: string) => {
        const table = requestedTable === 'settings' ? 'workspace_settings' : requestedTable
        // Supabase's generated fluent-builder type is intentionally erased only
        // inside this enforcement boundary; callers retain their generated type.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const builder = target.from(table as never) as any
        if (!tenantTables.has(table)) return builder

        return new Proxy(builder, {
          get(queryTarget, queryProperty, queryReceiver) {
            if (queryProperty === 'select') {
              return (...args: unknown[]) => queryTarget.select(...args)
                .eq('workspace_id', workspaceId)
            }
            if (queryProperty === 'insert') {
              return (values: Row | readonly Row[], ...args: unknown[]) =>
                queryTarget.insert(withWorkspace(values, workspaceId), ...args)
            }
            if (queryProperty === 'update') {
              return (values: Row, ...args: unknown[]) =>
                queryTarget.update(withWorkspace(values, workspaceId) as Row, ...args)
                  .eq('workspace_id', workspaceId)
            }
            if (queryProperty === 'delete') {
              return (...args: unknown[]) => queryTarget.delete(...args)
                .eq('workspace_id', workspaceId)
            }
            if (queryProperty === 'upsert') {
              return (values: Row | readonly Row[], options?: { onConflict?: string; [key: string]: unknown }) => {
                if (options?.onConflict && !options.onConflict.split(',').map((part) => part.trim()).includes('workspace_id')) {
                  throw new Error(`Workspace upsert conflict target must include workspace_id for ${table}`)
                }
                return queryTarget.upsert(withWorkspace(values, workspaceId), options)
              }
            }
            return Reflect.get(queryTarget, queryProperty, queryReceiver)
          },
        })
      }
    },
  }) as SupabaseClient<Database>
  registerWorkspaceServiceClient(scopedClient, workspaceId)
  return scopedClient
}
