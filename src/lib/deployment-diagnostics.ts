import 'server-only'

import { createHash } from 'node:crypto'
import {
  readV2GateState,
  supabaseProjectRef,
  validateV2DeploymentEnvironment,
} from './v2-runtime-safety'

function identifierHash(value: string | undefined): string | null {
  const normalized = value?.trim().toLowerCase()
  return normalized ? createHash('sha256').update(normalized).digest('hex').slice(0, 16) : null
}

export function getV2DeploymentDiagnostics(environment: NodeJS.ProcessEnv = process.env) {
  validateV2DeploymentEnvironment(environment)
  const supabaseRef = supabaseProjectRef(environment.NEXT_PUBLIC_SUPABASE_URL ?? '')

  return {
    appEnvironment: environment.REACHAGENT_ENV,
    runtimeIntent: environment.NEXT_PUBLIC_REACHAGENT_RUNTIME,
    deploymentBranch: environment.V2_DEPLOYMENT_BRANCH ?? null,
    vercelProjectName: environment.V2_VERCEL_PROJECT_NAME ?? null,
    supabaseProjectRefHash: identifierHash(supabaseRef ?? 'local-v2'),
    triggerProjectRefHash: identifierHash(environment.TRIGGER_V2_PROJECT_REF),
    buildCommit: environment.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) ?? null,
    nodeRuntime: process.versions.node,
    gates: readV2GateState(environment),
  }
}
