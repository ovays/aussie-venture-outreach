import { createBrowserClient } from '@supabase/ssr'
import { assertV2SupabaseTarget } from '@/lib/v2-runtime-safety'
import { readV2BrowserEnvironment } from '@/lib/v2-browser-environment'

export function createClient() {
  assertV2SupabaseTarget(readV2BrowserEnvironment())
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )
}
