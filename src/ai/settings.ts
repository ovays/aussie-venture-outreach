import 'server-only'

import { createServiceClient } from '@/lib/supabase/server'
import type {
  AIModelSetting,
  AIProviderSetting,
  AISettingsSnapshot,
  AIWorkflowSetting,
} from './settings-types'

interface ProviderRow {
  id: string
  provider_key: string
  display_name: string
  enabled: boolean
}

interface ModelRow {
  id: string
  provider_id: string
  model_key: string
  display_name: string
  enabled: boolean
}

interface WorkflowRow {
  id: string
  workflow_key: string
  enabled: boolean
  model_id: string
}

export async function loadAISettings(): Promise<AISettingsSnapshot> {
  const supabase = createServiceClient()
  const [providersResult, modelsResult, workflowsResult] = await Promise.all([
    supabase
      .from('ai_providers')
      .select('id, provider_key, display_name, enabled')
      .order('display_name'),
    supabase
      .from('ai_models')
      .select('id, provider_id, model_key, display_name, enabled')
      .order('display_name'),
    supabase
      .from('ai_workflow_configurations')
      .select('id, workflow_key, enabled, model_id')
      .order('workflow_key'),
  ])

  const error = providersResult.error ?? modelsResult.error ?? workflowsResult.error
  if (error) {
    throw new Error(`Unable to load AI settings: ${error.message}`)
  }

  const models = (modelsResult.data ?? []) as ModelRow[]
  const modelsById = new Map(models.map((model) => [model.id, model]))
  const mappedModels: AIModelSetting[] = models.map((model) => ({
    id: model.id,
    providerId: model.provider_id,
    modelKey: model.model_key,
    displayName: model.display_name,
    enabled: model.enabled,
  }))

  const providers: AIProviderSetting[] = ((providersResult.data ?? []) as ProviderRow[])
    .map((provider) => ({
      id: provider.id,
      providerKey: provider.provider_key,
      displayName: provider.display_name,
      enabled: provider.enabled,
      models: mappedModels.filter((model) => model.providerId === provider.id),
    }))

  const workflows: AIWorkflowSetting[] = ((workflowsResult.data ?? []) as WorkflowRow[])
    .map((workflow) => {
      const model = modelsById.get(workflow.model_id)
      if (!model) {
        throw new Error(`AI workflow "${workflow.workflow_key}" references an unknown model`)
      }

      return {
        id: workflow.id,
        workflowKey: workflow.workflow_key,
        enabled: workflow.enabled,
        modelId: workflow.model_id,
        providerId: model.provider_id,
      }
    })

  return { providers, workflows }
}
