export const AI_WORKFLOWS = [
  'website_extraction',
  'contact_email_extraction',
  'agentic_email_search',
  'outreach_email_generation',
  'outreach_dm_generation',
  'reactivation_email_generation',
] as const

export type AIWorkflow = (typeof AI_WORKFLOWS)[number]

export interface AIWorkflowAssignment {
  providerKey: string
  modelKey: string
}

export interface AIConfiguration {
  assignments: Readonly<Record<AIWorkflow, AIWorkflowAssignment>>
}
