export type PipelineAuthorization =
  | { allowed: true }
  | { allowed: false; status: 401 | 403; error: string }

export interface PipelineRunBoundaryDependencies {
  authorize: () => Promise<PipelineAuthorization>
  assertJobsEnabled: (operation: string) => void
  rateLimit: () => boolean
  trigger: () => Promise<{ id: string }>
}

export async function executePipelineRunBoundary(dependencies: PipelineRunBoundaryDependencies): Promise<{
  status: number
  body: { status?: 'triggered'; run_id?: string; error?: string }
}> {
  const authorization = await dependencies.authorize()
  if (!authorization.allowed) {
    return { status: authorization.status, body: { error: authorization.error } }
  }

  dependencies.assertJobsEnabled('manual pipeline trigger')
  if (!dependencies.rateLimit()) {
    return { status: 429, body: { error: 'Rate limit exceeded - max 3 triggers per minute' } }
  }

  try {
    const handle = await dependencies.trigger()
    return { status: 200, body: { status: 'triggered', run_id: handle.id } }
  } catch (error) {
    return { status: 500, body: { error: error instanceof Error ? error.message : String(error) } }
  }
}
