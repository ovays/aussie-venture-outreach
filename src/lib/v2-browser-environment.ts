export type V2BrowserEnvironment = {
  NEXT_PUBLIC_REACHAGENT_RUNTIME: string | undefined
  NEXT_PUBLIC_SUPABASE_URL: string | undefined
  NEXT_PUBLIC_REACHAGENT_V2_SUPABASE_PROJECT_REF: string | undefined
}

// Keep these as direct property references. Next.js only inlines NEXT_PUBLIC_*
// values into browser bundles when their names are statically analyzable.
export function readV2BrowserEnvironment(): V2BrowserEnvironment {
  return {
    NEXT_PUBLIC_REACHAGENT_RUNTIME:
      process.env.NEXT_PUBLIC_REACHAGENT_RUNTIME,
    NEXT_PUBLIC_SUPABASE_URL:
      process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_REACHAGENT_V2_SUPABASE_PROJECT_REF:
      process.env.NEXT_PUBLIC_REACHAGENT_V2_SUPABASE_PROJECT_REF,
  }
}
