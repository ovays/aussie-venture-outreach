export interface AIWorkflowConfigurationRecord {
  workflow: string
  providerKey: string
  modelKey: string
}

export interface AIConfigurationRepository {
  loadWorkflowConfigurations(): Promise<readonly AIWorkflowConfigurationRecord[]>
}
