// Lightweight prompt/workflow version identifiers for reproducibility and
// debugging. A version is recorded with each execution so a change in output
// can be correlated to a change in prompt construction. This is not a prompt
// management platform.

export const PROMPT_VERSIONS = {
  websiteExtraction: 'website_extraction.v1',
  contactEmailExtraction: 'contact_email_extraction.v1',
  agenticEmailSearch: 'agentic_email_search.v1',
  outreachEmailGeneration: 'outreach_email_generation.v1',
  outreachDmGeneration: 'outreach_dm_generation.v1',
} as const

export type PromptVersion = (typeof PROMPT_VERSIONS)[keyof typeof PROMPT_VERSIONS]
