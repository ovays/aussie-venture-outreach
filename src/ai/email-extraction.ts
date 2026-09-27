import { PROMPT_VERSIONS } from './prompt-versions'
import { AGENTIC_SEARCH_OUTPUT_SCHEMA, CONTACT_EMAIL_OUTPUT_SCHEMA } from './output'
import { createAIWorkflowContext, renderContextUserMessage } from './context'
import { executeAIWorkflow } from './execute'
import { isAIExecutionError } from './errors'
import { requireServerWorkspace, type AIExecuteWorkflow } from './harness'

export async function extractEmailWithHaiku(
  content: string,
  businessName: string,
  execute: AIExecuteWorkflow = executeAIWorkflow,
  workspaceId?: string,
): Promise<string | null> {
  const resolvedWorkspaceId = requireServerWorkspace(workspaceId)
  const context = createAIWorkflowContext({
    workspaceId: resolvedWorkspaceId,
    workflow: 'contact_email_extraction',
    promptVersion: PROMPT_VERSIONS.contactEmailExtraction,
  })
    .add({
      id: 'task',
      trustLevel: 'trusted_application',
      label: 'Task',
      content: `Find a contact email address for "${businessName}" in the supplied text. Respond in JSON only: { "email": "..." }. If no email is found, respond { "email": null }.`,
    })
    .add({
      id: 'text',
      trustLevel: 'external_untrusted',
      label: 'Text',
      content,
      source: { type: 'website' },
    })

  const built = context.getContext()
  const result = await execute({
    workflow: 'contact_email_extraction',
    promptVersion: PROMPT_VERSIONS.contactEmailExtraction,
    workspaceId: resolvedWorkspaceId,
    messages: [{ role: 'user', content: renderContextUserMessage(built) }],
    outputSchema: CONTACT_EMAIL_OUTPUT_SCHEMA,
    maxTokens: 64,
    contextSize: built.totalCharacters,
    contextTruncated: built.truncated,
  })

  const email = result.output.email
  if (email && email.includes('@') && !email.includes(' ') && email.length < 100) {
    return email
  }
  return null
}

interface AgentDecision {
  action: 'found' | 'fetch_url' | 'search_google' | 'not_found'
  email?: string | null
  url?: string | null
  search_query?: string | null
}

async function fetchPageText(url: string): Promise<string> {
  try {
    const normalised = url.startsWith('http') ? url : `https://${url}`
    const res = await fetch(normalised, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ReachAgentBot/1.0)' },
      signal: AbortSignal.timeout(10_000),
    })
    const html = await res.text()
    return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 4000)
  } catch {
    return ''
  }
}

async function searchWeb(query: string): Promise<string> {
  try {
    const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ReachAgentBot/1.0)',
        Accept: 'text/html',
      },
      signal: AbortSignal.timeout(10_000),
    })
    const html = await res.text()
    return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 4000)
  } catch {
    return ''
  }
}

const AGENTIC_SEARCH_SYSTEM = `You are a research agent that finds contact email addresses for businesses. Respond in valid JSON only — no other text.`

function renderDecisionPrompt(
  workspaceId: string,
  businessName: string,
  websiteUrl: string,
  category: string,
  content: string,
): string {
  const context = createAIWorkflowContext({
    workspaceId,
    workflow: 'agentic_email_search',
    promptVersion: PROMPT_VERSIONS.agenticEmailSearch,
  })
    .add({
      id: 'task',
      trustLevel: 'trusted_application',
      label: 'Task',
      content: `Find the contact email for this business. Choose ONE action and respond with JSON only:
- Found an email → {"action":"found","email":"email@domain.com"}
- Need to fetch a subpage → {"action":"fetch_url","url":"/contact"}
- Need an online search → {"action":"search_google","search_query":"${businessName} contact email"}
- Cannot find → {"action":"not_found"}`,
    })
    .add({
      id: 'business',
      trustLevel: 'internal_data',
      label: 'Business',
      content: `Business: ${businessName}\nWebsite: ${websiteUrl}\nCategory: ${category}`,
    })
    .add({
      id: 'content',
      trustLevel: 'external_untrusted',
      label: 'Page content',
      content,
      source: { type: 'website' },
    })

  return renderContextUserMessage(context.getContext())
}

export async function agenticEmailSearch(
  params: {
    business_name: string
    website_url: string
    category: string
    homepage_content: string
  },
  execute: AIExecuteWorkflow = executeAIWorkflow,
  workspaceId?: string,
): Promise<{ email: string | null; method: string; rounds: number }> {
  const MAX_ROUNDS = 3
  const resolvedWorkspaceId = requireServerWorkspace(workspaceId)

  const messages: { role: 'user' | 'assistant'; content: string }[] = [
    { role: 'user', content: renderDecisionPrompt(resolvedWorkspaceId, params.business_name, params.website_url, params.category, params.homepage_content) },
  ]

  let method = 'not_found'

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    let decision: AgentDecision
    let rawText: string
    try {
      const response = await execute({
        workflow: 'agentic_email_search',
        promptVersion: PROMPT_VERSIONS.agenticEmailSearch,
        workspaceId: resolvedWorkspaceId,
        system: AGENTIC_SEARCH_SYSTEM,
        messages,
        outputSchema: AGENTIC_SEARCH_OUTPUT_SCHEMA,
        maxTokens: 256,
      })
      decision = response.output
      rawText = response.rawText
    } catch (error) {
      // A malformed model reply must fail safe: stop searching rather than
      // trust an unvalidated action. Provider/transport failures propagate.
      if (isAIExecutionError(error) && error.code === 'AI_OUTPUT_INVALID') break
      throw error
    }

    console.log(`[email-agent] round=${round} action=${decision.action} email=${decision.email ?? '-'}`)

    if (decision.action === 'found' && decision.email) {
      if (round === 1) method = 'homepage'
      else if (method !== 'google_search') method = 'subpage'
      return { email: decision.email, method, rounds: round }
    }

    if (decision.action === 'not_found') {
      break
    }

    // Execute the suggested action
    let fetchedContent = ''

    if (decision.action === 'fetch_url' && decision.url) {
      let target = decision.url
      if (!target.startsWith('http')) {
        try {
          const base = new URL(
            params.website_url.startsWith('http') ? params.website_url : `https://${params.website_url}`
          )
          target = base.origin + (decision.url.startsWith('/') ? decision.url : `/${decision.url}`)
        } catch {
          target = params.website_url + decision.url
        }
      }
      fetchedContent = await fetchPageText(target)
      method = 'subpage'
    } else if (decision.action === 'search_google' && decision.search_query) {
      fetchedContent = await searchWeb(decision.search_query)
      method = 'google_search'
    }

    messages.push({ role: 'assistant', content: rawText })

    if (!fetchedContent) {
      messages.push({
        role: 'user',
        content: 'That returned no content. Try a different approach or return {"action":"not_found"}.',
      })
      continue
    }

    messages.push({
      role: 'user',
      content: `Content from ${decision.action === 'search_google' ? 'search results' : 'that page'}:

${fetchedContent}

Now decide. JSON only: {"action":"found","email":"..."} or {"action":"fetch_url","url":"..."} or {"action":"search_google","search_query":"..."} or {"action":"not_found"}`,
    })
  }

  return { email: null, method: 'not_found', rounds: MAX_ROUNDS }
}
