import { z } from 'zod'

const schema = z.object({
  NEXT_PUBLIC_REACHAGENT_RUNTIME: z.literal('v2'),
  NEXT_PUBLIC_REACHAGENT_V2_SUPABASE_PROJECT_REF: z.string().optional(),
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().startsWith('sk-ant-').optional(),
  OPENAI_API_KEY: z.string().startsWith('sk-').optional(),
  GEMINI_API_KEY: z.string().min(1).optional(),
  RESEND_API_KEY: z.string().startsWith('re_').optional(),
  RESEND_API_KEY_V2: z.string().startsWith('re_').optional(),
  OUTSCRAPER_API_KEY: z.string().min(1).optional(),
  TRIGGER_SECRET_KEY: z.string().min(1).optional(),
  REACHAGENT_ENV: z.enum(['local_v2', 'v2_staging', 'v2_canary']).default('local_v2'),
  OUTREACH_SEND_ENABLED: z.enum(['true', 'false']).default('false'),
  TRIGGER_JOBS_ENABLED: z.enum(['true', 'false']).default('false'),
  HOSTINGER_MUTATIONS_ENABLED: z.enum(['true', 'false']).default('false'),
  FINDER_SCHEDULE_ENABLED: z.enum(['true', 'false']).default('false'),
  ORCHESTRATOR_ENABLED: z.enum(['true', 'false']).default('false'),
  ORCHESTRATOR_SHADOW: z.enum(['true', 'false']).default('false'),
  V2_SHADOW_ALLOW_PRODUCTION_READS: z.enum(['true', 'false']).default('false'),
  SHADOW_OBSERVABILITY_WRITE_ENABLED: z.enum(['true', 'false']).default('false'),
  V2_CANARY_ENABLED: z.enum(['true', 'false']).default('false'),
  V2_CANARY_LEAD_IDS: z.string().optional(),
  V2_CANARY_APPROVAL_TOKEN: z.string().optional(),
  V2_CANARY_APPROVED_CONTENT_HASH: z.string().optional(),
  V2_CANARY_APPROVAL_REFERENCE: z.string().optional(),
  V2_SHADOW_SUPABASE_URL: z.string().url().optional(),
  V2_SHADOW_SUPABASE_READ_KEY: z.string().min(1).optional(),
  V2_SHADOW_SUPABASE_PUBLISHABLE_KEY: z.string().startsWith('sb_publishable_').optional(),
  V2_SHADOW_SUPABASE_ACCESS_TOKEN: z.string().min(1).optional(),
  V2_SHADOW_SUPABASE_SCHEMA: z.literal('reachagent_prompt15_shadow').optional(),
  GOOGLE_MAPS_API_KEY: z.string().optional(),
  MAILBOX_CREDENTIAL_ENCRYPTION_KEY: z.string().optional(),
  MAILBOX_OAUTH_REDIRECT_BASE_URL: z.string().url().optional(),
  GOOGLE_MAILBOX_CLIENT_ID: z.string().optional(),
  GOOGLE_MAILBOX_CLIENT_SECRET: z.string().optional(),
  MICROSOFT_MAILBOX_CLIENT_ID: z.string().optional(),
  MICROSOFT_MAILBOX_CLIENT_SECRET: z.string().optional(),
  MICROSOFT_MAILBOX_TENANT_ID: z.string().optional(),
  NEXT_PUBLIC_APP_URL: z.string().url().optional().default('http://localhost:3000'),
  STRIPE_SECRET_KEY: z.string().startsWith('sk_test_').optional(),
  STRIPE_WEBHOOK_SECRET: z.string().startsWith('whsec_').optional(),
  STRIPE_PRICE_STARTER_MONTHLY: z.string().startsWith('price_').optional(),
  STRIPE_PRICE_GROWTH_MONTHLY: z.string().startsWith('price_').optional(),
  STRIPE_PRICE_PRO_MONTHLY: z.string().startsWith('price_').optional(),
})

export type Env = z.infer<typeof schema>

let _env: Env | null = null

export function getEnv(): Env {
  if (!_env) {
    const result = schema.safeParse(process.env)
    if (!result.success) {
      const problems = result.error.issues
        .map(i => `${i.path.join('.')}: ${i.message}`)
        .join(', ')
      throw new Error(`Environment validation failed — ${problems}`)
    }
    _env = result.data
  }
  return _env
}
