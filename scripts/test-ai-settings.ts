import assert from 'node:assert/strict'
import { createClient } from '@supabase/supabase-js'
import { AIConfigurationService } from '@/ai/configuration/AIConfigurationService'
import type {
  AIConfigurationRepository,
  AIWorkflowConfigurationRecord,
} from '@/ai/configuration/AIConfigurationRepository'

interface ConfigurationRow {
  workflow_key: string
  ai_models: {
    model_key: string
    ai_providers: { provider_key: string } | { provider_key: string }[]
  } | Array<{
    model_key: string
    ai_providers: { provider_key: string } | { provider_key: string }[]
  }>
}

function one<T>(value: T | T[]): T {
  return Array.isArray(value) ? value[0] : value
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  assert(url && serviceRoleKey, 'Supabase environment variables are required')

  const supabase = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  class LiveRepository implements AIConfigurationRepository {
    async loadWorkflowConfigurations(): Promise<readonly AIWorkflowConfigurationRecord[]> {
      const { data, error } = await supabase
        .from('ai_workflow_configurations')
        .select('workflow_key, ai_models!inner(model_key, ai_providers!inner(provider_key))')
        .eq('enabled', true)
        .eq('ai_models.enabled', true)
        .eq('ai_models.ai_providers.enabled', true)

      if (error) throw error
      return ((data ?? []) as unknown as ConfigurationRow[]).map((row) => {
        const model = one(row.ai_models)
        const provider = one(model.ai_providers)
        return {
          workflow: row.workflow_key,
          providerKey: provider.provider_key,
          modelKey: model.model_key,
        }
      })
    }
  }

  const { data: models, error: modelsError } = await supabase
    .from('ai_models')
    .select('id, model_key, ai_providers!inner(provider_key)')
    .eq('enabled', true)
    .eq('ai_providers.enabled', true)

  if (modelsError) throw modelsError

  const modelByProvider = new Map<string, { id: string; modelKey: string }>()
  for (const model of models ?? []) {
    const provider = one(model.ai_providers as { provider_key: string } | { provider_key: string }[])
    if (!modelByProvider.has(provider.provider_key)) {
      modelByProvider.set(provider.provider_key, { id: model.id, modelKey: model.model_key })
    }
  }

  for (const providerKey of ['anthropic', 'openai', 'gemini']) {
    assert(modelByProvider.has(providerKey), `${providerKey} must have an enabled model`)
  }

  const { data: workflow, error: workflowError } = await supabase
    .from('ai_workflow_configurations')
    .select('id, model_id')
    .eq('workflow_key', 'outreach_email_generation')
    .single()

  if (workflowError) throw workflowError
  if (!workflow) throw new Error('outreach_email_generation workflow is missing')

  const workflowId = workflow.id
  const originalModelId = workflow.model_id
  const service = new AIConfigurationService(new LiveRepository(), 60_000)

  async function assign(providerKey: string) {
    const model = modelByProvider.get(providerKey)
    assert(model)
    const { data, error } = await supabase
      .from('ai_workflow_configurations')
      .update({ model_id: model.id })
      .eq('id', workflowId)
      .select('model_id')
      .single()

    if (error) throw error
    assert.equal(data.model_id, model.id, `${providerKey} model ID is persisted`)
  }

  try {
    await assign('anthropic')
    service.invalidate()
    assert.equal(
      (await service.getWorkflowAssignment('outreach_email_generation')).providerKey,
      'anthropic'
    )

    await assign('openai')
    assert.equal(
      (await service.getWorkflowAssignment('outreach_email_generation')).providerKey,
      'anthropic',
      'the cached assignment remains until invalidation'
    )
    service.invalidate()
    assert.equal(
      (await service.getWorkflowAssignment('outreach_email_generation')).providerKey,
      'openai',
      'invalidation reloads the OpenAI database assignment'
    )

    await assign('gemini')
    service.invalidate()
    assert.equal(
      (await service.getWorkflowAssignment('outreach_email_generation')).providerKey,
      'gemini',
      'invalidation reloads the Gemini database assignment'
    )

    console.log('AI settings database assignment and cache invalidation tests passed')
  } finally {
    const { error } = await supabase
      .from('ai_workflow_configurations')
      .update({ model_id: originalModelId })
      .eq('id', workflowId)
    if (error) throw error
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
