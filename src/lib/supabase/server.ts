import { createServerClient } from '@supabase/ssr'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'
import ws from 'ws'
import { assertV2SupabaseTarget } from '@/lib/v2-runtime-safety'

export async function createClient() {
  assertV2SupabaseTarget()
  const cookieStore = await cookies()

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          } catch {
            // Server Component - cookies can't be set here; middleware handles this
          }
        },
      },
    }
  )
}

export function createServiceClient() {
  assertV2SupabaseTarget()
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
      realtime: {
        transport: ws as unknown as typeof WebSocket,
      },
    }
  )
}
