import { PROMPT_VERSIONS } from './prompt-versions'
import { WEBSITE_EXTRACTION_OUTPUT_SCHEMA } from './output'
import { createAIWorkflowContext, renderContextUserMessage } from './context'
import { executeAIWorkflow } from './execute'
import { requireServerWorkspace, type AIExecuteWorkflow } from './harness'

const WEBSITE_EXTRACTION_TASK = [
  'Extract the following from the supplied business website content:',
  '- Brief description (1-2 sentences)',
  '- Main services offered',
  '- Instagram handle (if mentioned, just the handle like @businessname)',
  '- Facebook URL (if mentioned)',
  '- Any other social media',
  '',
  'Respond in JSON only with keys: description, services, instagram_handle, facebook_url, other_social',
].join('\n')

/**
 * Extracts structured business facts from scraped website content. The scraped
 * page is untrusted data: it is rendered inside an explicitly delimited
 * external-data section and can never carry instruction, workspace, policy or
 * authority. Output is schema-validated before it is stored or interpolated.
 */
export async function extractWebsiteData(
  websiteContent: string,
  execute: AIExecuteWorkflow = executeAIWorkflow,
  workspaceId?: string,
): Promise<{
  description: string
  services: string
  instagram_handle: string | null
  facebook_url: string | null
  other_social: string | null
}> {
  const resolvedWorkspaceId = requireServerWorkspace(workspaceId)
  const context = createAIWorkflowContext({
    workspaceId: resolvedWorkspaceId,
    workflow: 'website_extraction',
    promptVersion: PROMPT_VERSIONS.websiteExtraction,
  })
    .add({
      id: 'task',
      trustLevel: 'trusted_application',
      label: 'Task',
      content: WEBSITE_EXTRACTION_TASK,
    })
    .add({
      id: 'website',
      trustLevel: 'external_untrusted',
      label: 'Website content',
      content: websiteContent,
      source: { type: 'website' },
    })

  const built = context.getContext()
  const result = await execute({
    workflow: 'website_extraction',
    promptVersion: PROMPT_VERSIONS.websiteExtraction,
    workspaceId: resolvedWorkspaceId,
    messages: [{ role: 'user', content: renderContextUserMessage(built) }],
    outputSchema: WEBSITE_EXTRACTION_OUTPUT_SCHEMA,
    maxTokens: 512,
    contextSize: built.totalCharacters,
    contextTruncated: built.truncated,
  })

  const value = result.output
  return {
    description: coerceToText(value.description),
    services: coerceToText(value.services),
    instagram_handle: value.instagram_handle || null,
    facebook_url: value.facebook_url || null,
    other_social: coerceToNullableText(value.other_social),
  }
}

function coerceToText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.join(', ')
  return ''
}

function coerceToNullableText(value: unknown): string | null {
  const text = coerceToText(value).trim()
  return text || null
}
