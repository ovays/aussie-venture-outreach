import { isCanonicalUuid } from '@/lib/uuid'
import {
  DEFAULT_CONTEXT_LIMITS,
  truncateText,
  type AIContextLimits,
} from './limits'
import type { AIContextSource } from './types'
import { isUntrustedLevel } from './trust'
import type { AITrustLevel } from './trust'
import type { AIContextItem, AIWorkflowContext } from './types'

export interface AddContextItemInput {
  id: string
  trustLevel: AITrustLevel
  label: string
  content: string
  source?: AIContextSource
}

export interface CreateContextInput {
  /** Authoritative server-resolved workspace id (canonical UUID). Required —
   * production AI context is always explicitly workspace-scoped. Pure prompt
   * rendering that genuinely has no workspace uses renderContextItems directly
   * rather than constructing a production AIWorkflowContext. */
  workspaceId: string
  workflow: string
  promptVersion: string
  limits?: Partial<AIContextLimits>
}

/**
 * Builds the minimum, explicitly workspace-scoped context for a workflow.
 * Items are kept as typed entries (with provenance and bounds) rather than
 * flattened into one string so the renderer can keep trusted instructions and
 * untrusted data architecturally separate.
 */
export class AIWorkflowContextBuilder {
  private readonly limits: AIContextLimits
  private readonly items: AIContextItem[] = []
  private untrustedChars = 0
  private trustedChars = 0

  constructor(private readonly input: CreateContextInput) {
    if (!isCanonicalUuid(input.workspaceId)) {
      throw new Error('AI workflow context requires a valid workspace id')
    }
    if (!input.workflow.trim()) throw new Error('AI workflow context requires a workflow')
    if (!input.promptVersion.trim()) throw new Error('AI workflow context requires a prompt version')
    this.limits = { ...DEFAULT_CONTEXT_LIMITS, ...input.limits }
  }

  add(item: AddContextItemInput): this {
    if (this.items.some((existing) => existing.id === item.id)) {
      throw new Error(`AI context item id "${item.id}" is not unique within the context`)
    }

    const untrusted = isUntrustedLevel(item.trustLevel)
    const perItemCap = untrusted ? this.limits.maxUntrustedItemChars : this.limits.maxTotalChars
    const bounded = truncateText(item.content, perItemCap)
    const entry: AIContextItem = {
      id: item.id,
      trustLevel: item.trustLevel,
      label: item.label,
      content: bounded.text,
      source: item.source,
      truncated: bounded.truncated,
      originalLength: item.content.length,
    }

    if (untrusted) this.untrustedChars += entry.content.length
    else this.trustedChars += entry.content.length

    this.items.push(entry)
    return this
  }

  getContext(): AIWorkflowContext {
    const truncated =
      this.items.some((item) => item.truncated)
      || this.untrustedChars > this.limits.maxUntrustedChars
      || this.trustedChars > this.limits.maxTrustedChars
      || this.untrustedChars + this.trustedChars > this.limits.maxTotalChars

    return {
      workspaceId: this.input.workspaceId,
      workflow: this.input.workflow,
      promptVersion: this.input.promptVersion,
      items: this.items,
      totalCharacters: this.trustedChars + this.untrustedChars,
      truncated,
    }
  }
}

export function createAIWorkflowContext(input: CreateContextInput): AIWorkflowContextBuilder {
  return new AIWorkflowContextBuilder(input)
}
