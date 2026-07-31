import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/server'
import type {
  AIConfigurationRepository,
  AIWorkflowConfigurationRecord,
} from '../AIConfigurationRepository'

type RelatedProvider = {
  provider_key: string
}

type RelatedModel = {
  model_key: string
  ai_providers: RelatedProvider | RelatedProvider[]
}

type AIWorkflowConfigurationRow = {
  workflow_key: string
  ai_models: RelatedModel | RelatedModel[]
}

function one<T>(value: T | T[]): T | undefined {
  return Array.isArray(value) ? value[0] : value
}

export class SupabaseAIConfigurationRepository implements AIConfigurationRepository {
  constructor(
    private readonly createClient: () => SupabaseClient = createServiceClient
  ) {}

  async loadWorkflowConfigurations(): Promise<readonly AIWorkflowConfigurationRecord[]> {
    const { data, error } = await this.createClient()
      .from('ai_workflow_configurations')
      .select(`
        workflow_key,
        ai_models!inner(
          model_key,
          ai_providers!inner(provider_key)
        )
      `)
      .eq('enabled', true)
      .eq('ai_models.enabled', true)
      .eq('ai_models.ai_providers.enabled', true)

    if (error) {
      throw new Error(`Unable to load AI workflow configuration: ${error.message}`)
    }

    return ((data ?? []) as unknown as AIWorkflowConfigurationRow[]).map((row) => {
      const model = one(row.ai_models)
      const provider = model ? one(model.ai_providers) : undefined

      if (!model || !provider) {
        throw new Error(
          `AI workflow "${row.workflow_key}" has an invalid provider or model relationship`
        )
      }

      return {
        workflow: row.workflow_key,
        providerKey: provider.provider_key,
        modelKey: model.model_key,
      }
    })
  }
}
