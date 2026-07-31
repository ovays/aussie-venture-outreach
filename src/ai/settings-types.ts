export interface AIModelSetting {
  id: string
  providerId: string
  modelKey: string
  displayName: string
  enabled: boolean
}

export interface AIProviderSetting {
  id: string
  providerKey: string
  displayName: string
  enabled: boolean
  models: AIModelSetting[]
}

export interface AIWorkflowSetting {
  id: string
  workflowKey: string
  enabled: boolean
  modelId: string
  providerId: string
}

export interface AISettingsSnapshot {
  providers: AIProviderSetting[]
  workflows: AIWorkflowSetting[]
}
