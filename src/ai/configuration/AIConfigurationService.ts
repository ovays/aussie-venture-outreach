import {
  AI_WORKFLOWS,
  type AIConfiguration,
  type AIWorkflow,
  type AIWorkflowAssignment,
} from './AIConfiguration'
import type {
  AIConfigurationRepository,
  AIWorkflowConfigurationRecord,
} from './AIConfigurationRepository'

export function validateConfiguration(
  rows: readonly AIWorkflowConfigurationRecord[]
): AIConfiguration {
  const assignments = {} as Record<AIWorkflow, AIWorkflowAssignment>
  const supportedWorkflows = new Set<string>(AI_WORKFLOWS)

  for (const row of rows) {
    if (!supportedWorkflows.has(row.workflow)) {
      continue
    }

    const workflow = row.workflow as AIWorkflow
    if (assignments[workflow]) {
      throw new Error(`AI workflow "${workflow}" has more than one active configuration`)
    }
    if (!row.providerKey.trim()) {
      throw new Error(`AI workflow "${workflow}" has an empty provider key`)
    }
    if (!row.modelKey.trim()) {
      throw new Error(`AI workflow "${workflow}" has an empty model key`)
    }

    assignments[workflow] = {
      providerKey: row.providerKey,
      modelKey: row.modelKey,
    }
  }

  const missing = AI_WORKFLOWS.filter((workflow) => !assignments[workflow])
  if (missing.length > 0) {
    throw new Error(`AI configuration is missing workflows: ${missing.join(', ')}`)
  }

  return { assignments }
}

export class AIConfigurationService {
  private cached:
    | {
        configuration: AIConfiguration
        expiresAt: number
      }
    | undefined
  private loading: Promise<AIConfiguration> | undefined
  private invalidationVersion = 0

  constructor(
    private readonly repository: AIConfigurationRepository,
    private readonly cacheTtlMs = 60_000,
    private readonly now: () => number = Date.now
  ) {}

  async getConfiguration(): Promise<AIConfiguration> {
    if (this.cached && this.cached.expiresAt > this.now()) {
      return this.cached.configuration
    }

    if (!this.loading) {
      const loadVersion = this.invalidationVersion
      const loading = this.repository.loadWorkflowConfigurations()
        .then(validateConfiguration)
        .then((configuration) => {
          if (loadVersion === this.invalidationVersion) {
            this.cached = {
              configuration,
              expiresAt: this.now() + this.cacheTtlMs,
            }
          }
          return configuration
        })
        .finally(() => {
          if (this.loading === loading) {
            this.loading = undefined
          }
        })
      this.loading = loading
    }

    return this.loading
  }

  async getWorkflowAssignment(
    workflow: AIWorkflow
  ): Promise<AIWorkflowAssignment> {
    return (await this.getConfiguration()).assignments[workflow]
  }

  invalidate(): void {
    this.cached = undefined
    this.loading = undefined
    this.invalidationVersion += 1
  }
}
