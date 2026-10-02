import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'

export interface CustomerAnalytics {
  total_leads: number
  contacted: number
  replies: number
  interested: number
  not_interested: number
  reply_rate: number
  interested_rate: number
  trend: Array<{ date: string; contacted: number; replies: number }>
  categories: Array<{ category: string; total_leads: number; contacted: number; replies: number; interested: number; reply_rate: number }>
}

export async function getCustomerAnalytics(db: SupabaseClient<Database>, workspaceId: string): Promise<CustomerAnalytics> {
  const { data, error } = await db.rpc('get_customer_analytics' as never, {
    p_workspace_id: workspaceId,
    p_as_of: new Date().toISOString(),
  } as never)
  if (error) throw new Error(`Customer analytics failed: ${error.message}`)
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Customer analytics returned an invalid payload')
  return data as unknown as CustomerAnalytics
}
