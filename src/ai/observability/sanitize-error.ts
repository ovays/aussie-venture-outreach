export function sanitizeAIErrorMessage(
  error: unknown,
  sensitiveValues: ReadonlyArray<string | null | undefined>
): string {
  let message = error instanceof Error ? error.message : String(error)
  for (const value of sensitiveValues) {
    if (value && value.length >= 4) message = message.split(value).join('[REDACTED]')
  }
  return message.slice(0, 2_000)
}
