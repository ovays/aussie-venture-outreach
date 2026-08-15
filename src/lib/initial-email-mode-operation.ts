import { isInitialEmailMode, type InitialEmailMode } from '@/lib/settingsDefaults'

type FetchInitialEmailMode = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export async function captureInitialEmailModeSnapshot(
  fetchInitialEmailMode: FetchInitialEmailMode = fetch,
): Promise<InitialEmailMode> {
  const response = await fetchInitialEmailMode('/api/leads/bulk', { method: 'GET' })
  const json = await response.json() as { initial_email_mode?: unknown; error?: string }
  if (!response.ok) throw new Error(json.error ?? 'Unable to resolve Initial Email mode')
  if (typeof json.initial_email_mode !== 'string' || !isInitialEmailMode(json.initial_email_mode)) {
    throw new Error('The server returned an invalid Initial Email mode')
  }
  return json.initial_email_mode
}
