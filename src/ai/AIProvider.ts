import type { AIWorkflow } from './configuration/AIConfiguration'

export interface AIMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface AIGenerateRequest {
  workflow: AIWorkflow
  model: string
  maxTokens: number
  system?: string
  messages: readonly AIMessage[]
}

export interface AIGenerateResponse {
  text: string
  usage?: AITokenUsage
  retryCount?: number
}

export interface AITokenUsage {
  inputTokens: number | null
  outputTokens: number | null
  totalTokens: number | null
}

export interface AIProvider {
  generate(request: AIGenerateRequest): Promise<AIGenerateResponse>
}
