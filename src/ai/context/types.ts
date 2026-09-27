import type { AITrustLevel } from './trust'

/**
 * Lightweight provenance for a context item. Enough to distinguish
 * application-configured facts from database facts, externally researched claims
 * and AI-generated inference — not a citation/RAG platform.
 */
export interface AIContextSource {
  /** Stable kind discriminator, e.g. 'database', 'website', 'ai_research', 'inbound_email'. */
  type: string
  /** Optional stable identifier of the originating record. */
  id?: string
  /** Origin URL when already available. Never a secret. */
  url?: string
  /** ISO timestamp of retrieval/derivation. */
  retrievedAt?: string
}

export interface AIContextItem {
  /** Unique within a single workflow context. */
  id: string
  trustLevel: AITrustLevel
  /** Human-readable label rendered next to the content, e.g. "Business description". */
  label: string
  /** Bounded content. */
  content: string
  source?: AIContextSource
  /** True when the content was truncated to fit a bound. */
  truncated: boolean
  /** Length of the content before any bound was applied. */
  originalLength: number
}

export interface AIWorkflowContext {
  /** Authoritative server-resolved workspace. Never derived from request/model output. */
  workspaceId: string
  workflow: string
  promptVersion: string
  items: readonly AIContextItem[]
  /** Total characters across all items after bounds were applied. */
  totalCharacters: number
  /** True when any item (or the total) was truncated. */
  truncated: boolean
}
