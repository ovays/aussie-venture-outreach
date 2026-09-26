import { AIRegistry } from './AIRegistry'
import { AIConfigurationService } from './configuration/AIConfigurationService'
import { SupabaseAIConfigurationRepository } from './configuration/repositories/SupabaseAIConfigurationRepository'
import { AnthropicProvider } from './providers/AnthropicProvider'
import { GeminiProvider } from './providers/GeminiProvider'
import { OpenAIProvider } from './providers/OpenAIProvider'
import { aiRequestLogger } from './observability/runtime'
import { consumeAIRequestQuota } from '@/lib/quota/gate'

export const aiConfigurationService = new AIConfigurationService(
  new SupabaseAIConfigurationRepository()
)

export const aiRegistry = new AIRegistry(
  aiConfigurationService,
  aiRequestLogger,
  Date.now,
  'application',
  consumeAIRequestQuota,
)
  .register('anthropic', new AnthropicProvider())
  .register('openai', new OpenAIProvider())
  .register('gemini', new GeminiProvider())
