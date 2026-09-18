export interface OrchestratorFlags {
  enabled: boolean
  shadow: boolean
}

export function readOrchestratorFlags(environment: NodeJS.ProcessEnv = process.env): OrchestratorFlags {
  return {
    enabled: environment.ORCHESTRATOR_ENABLED === 'true',
    shadow: environment.ORCHESTRATOR_SHADOW === 'true',
  }
}
