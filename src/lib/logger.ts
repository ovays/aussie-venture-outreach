type LogLevel = 'info' | 'warn' | 'error' | 'debug'

function log(level: LogLevel, agent: string, msg: string, meta?: Record<string, unknown>): void {
  const entry: Record<string, unknown> = { ts: new Date().toISOString(), level, agent, msg }
  if (meta) Object.assign(entry, meta)
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
