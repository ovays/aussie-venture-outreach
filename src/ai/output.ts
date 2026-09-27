import { z } from 'zod'
import { AIExecutionError } from './errors'

// Structured-output contracts for machine-consumed AI responses. Every workflow
// that parses model text for downstream application logic must validate through
// a schema here rather than trusting JSON.parse(raw) directly.

export const WEBSITE_EXTRACTION_OUTPUT_SCHEMA = z.object({
  description: z.string().max(4_000).default(''),
  services: z.union([z.string(), z.array(z.string())]).default(''),
  instagram_handle: z.string().nullable().default(null),
  facebook_url: z.string().nullable().default(null),
  other_social: z.union([z.string(), z.array(z.string()), z.null()]).default(null),
})

export const CONTACT_EMAIL_OUTPUT_SCHEMA = z.object({
  email: z.string().nullable().default(null),
})

export const AGENTIC_SEARCH_OUTPUT_SCHEMA = z.object({
  action: z.enum(['found', 'fetch_url', 'search_google', 'not_found']),
  email: z.string().nullable().optional(),
  url: z.string().nullable().optional(),
  search_query: z.string().nullable().optional(),
})

export const WRITER_OUTPUT_SCHEMA = z.object({
  subject: z.string().max(500).optional(),
  body: z.string().min(1).max(12_000),
})

export type WebsiteExtractionOutput = z.infer<typeof WEBSITE_EXTRACTION_OUTPUT_SCHEMA>
export type ContactEmailOutput = z.infer<typeof CONTACT_EMAIL_OUTPUT_SCHEMA>
export type AgenticSearchOutput = z.infer<typeof AGENTIC_SEARCH_OUTPUT_SCHEMA>
export type WriterOutput = z.infer<typeof WRITER_OUTPUT_SCHEMA>

export interface ParsedAIOutput<T> {
  value: T
  rawText: string
}

/**
 * Deterministically extracts a JSON object from model text, validates it
 * against a schema, and fails closed on any malformed shape. No field is
 * invented to satisfy the schema — defaults are only applied for explicitly
 * optional fields.
 */
export function parseStructuredOutput<T extends z.ZodTypeAny>(
  schema: T,
  rawText: string,
): z.infer<T> {
  const trimmed = (rawText ?? '').trim()
  if (!trimmed) throw new AIExecutionError('AI_OUTPUT_INVALID', 'AI returned no output', false)

  const jsonMatch = trimmed.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    throw new AIExecutionError('AI_OUTPUT_INVALID', 'AI output did not contain a JSON object', false)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonMatch[0])
  } catch {
    throw new AIExecutionError('AI_OUTPUT_INVALID', 'AI output was not valid JSON', false)
  }

  const result = schema.safeParse(parsed)
  if (!result.success) {
    const detail = result.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`)
      .join('; ')
    throw new AIExecutionError('AI_OUTPUT_INVALID', `AI output failed schema validation: ${detail}`, false)
  }

  return result.data as z.infer<T>
}
