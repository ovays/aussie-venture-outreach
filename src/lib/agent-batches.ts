function boundedInteger(value: string | undefined, fallback: number, maximum: number): number {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback
}

export const RESEARCHER_BATCH_SIZE = boundedInteger(process.env.RESEARCHER_BATCH_SIZE, 100, 500)
export const BOUNCED_EMAIL_REPAIR_BATCH_SIZE = boundedInteger(process.env.BOUNCED_EMAIL_REPAIR_BATCH_SIZE, 25, 100)
export const WRITER_BATCH_SIZE = boundedInteger(process.env.WRITER_BATCH_SIZE, 100, 500)
export const WRITER_STALE_RESET_BATCH_SIZE = boundedInteger(process.env.WRITER_STALE_RESET_BATCH_SIZE, 200, 500)
export const REACTIVATION_BATCH_SIZE = boundedInteger(process.env.REACTIVATION_BATCH_SIZE, 100, 500)
