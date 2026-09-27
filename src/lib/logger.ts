import { sanitizeObservabilityMetadata } from '@/lib/observability/sanitize'

type LogLevel = 'info' | 'warn' | 'error' | 'debug'

function log(level: LogLevel, agent: string, msg: string, meta?: Record<string, unknown>): void {
  const safeMessage = msg
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/(?:sk|key|token|secret)[-_][A-Za-z0-9_-]{8,}/gi, '[REDACTED]')
    .slice(0, 1_000)
  const entry: Record<string, unknown> = { ts: new Date().toISOString(), level, agent: agent.slice(0, 100), msg: safeMessage }
  if (meta) Object.assign(entry, sanitizeObservabilityMetadata(meta))
  const line = JSON.stringify(entry)
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
}

export const logger = {
  info:  (agent: string, msg: string, meta?: Record<string, unknown>) => log('info',  agent, msg, meta),
  warn:  (agent: string, msg: string, meta?: Record<string, unknown>) => log('warn',  agent, msg, meta),
  error: (agent: string, msg: string, meta?: Record<string, unknown>) => log('error', agent, msg, meta),
  debug: (agent: string, msg: string, meta?: Record<string, unknown>) => log('debug', agent, msg, meta),
}
