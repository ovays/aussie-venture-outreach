import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'

const BLOCKED_METHODS = new Set(['insert', 'upsert', 'update', 'delete', 'rpc'])

export interface ReadOnlyClientAudit {
  blockedMutationAttempts: number
  allowedMethodCalls: number
}

/** Runtime capability facade: query builders work normally, while every
 * Supabase mutation/RPC method throws before a request can be constructed. */
export function createReadOnlySupabaseClient(
  client: SupabaseClient<Database>,
  audit: ReadOnlyClientAudit = { blockedMutationAttempts: 0, allowedMethodCalls: 0 },
): SupabaseClient<Database> {
  const seen = new WeakMap<object, object>()
  const wrap = (value: unknown): unknown => {
    if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return value
    const objectValue = value as object
    const existing = seen.get(objectValue)
    if (existing) return existing
    const proxy = new Proxy(objectValue, {
      get(target, property, receiver) {
        if (typeof property === 'string' && BLOCKED_METHODS.has(property)) {
          return () => {
            audit.blockedMutationAttempts++
            throw new Error(`Shadow read-only client blocked Supabase mutation method: ${property}`)
          }
        }
        const member = Reflect.get(target, property, receiver)
        if (property === 'then' && typeof member === 'function') return member.bind(target)
        if (typeof member !== 'function') return member
        return (...args: unknown[]) => {
          audit.allowedMethodCalls++
          return wrap(Reflect.apply(member, target, args))
        }
      },
    })
    seen.set(objectValue, proxy)
    return proxy
  }
  return wrap(client) as SupabaseClient<Database>
}
