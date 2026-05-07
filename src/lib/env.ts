import { z } from 'zod'

const schema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().startsWith('sk-ant-'),
  RESEND_API_KEY: z.string().startsWith('re_'),
  OUTSCRAPER_API_KEY: z.string().min(1),
  TRIGGER_SECRET_KEY: z.string().min(1),
  NEXT_PUBLIC_APP_URL: z.string().url().optional().default('http://localhost:3000'),
  ADMIN_EMAIL: z.string().email().optional(),
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
