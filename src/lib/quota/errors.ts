// Typed errors for quota decisions. Callers match on the code, never on a
// human-readable message, so blocked operations stay deterministic.

export const QUOTA_EXCEEDED_CODE = 'QUOTA_EXCEEDED' as const
export const NO_ENTITLEMENT_CODE = 'NO_ENTITLEMENT' as const

export type QuotaErrorCode = typeof QUOTA_EXCEEDED_CODE | typeof NO_ENTITLEMENT_CODE

export class QuotaExceededError extends Error {
  readonly code = QUOTA_EXCEEDED_CODE

  constructor(
    readonly dimension: string,
    message?: string,
  ) {
    super(message ?? `Quota exceeded for dimension "${dimension}"`)
    this.name = 'QuotaExceededError'
  }
}

export class NoEntitlementError extends Error {
  readonly code = NO_ENTITLEMENT_CODE

  constructor(dimension: string) {
    super(`Workspace has no entitlement; cannot evaluate "${dimension}"`)
    this.name = 'NoEntitlementError'
  }
}

export function isQuotaExceededError(error: unknown): error is QuotaExceededError {
  return error instanceof QuotaExceededError
}

export function isNoEntitlementError(error: unknown): error is NoEntitlementError {
  return error instanceof NoEntitlementError
}
