export interface HostingerInboundTaskPayload {
  receiptId: string
}

export function validateHostingerInboundTaskPayload(payload: unknown): HostingerInboundTaskPayload {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Invalid Hostinger inbound task payload: expected an object')
  }

  const keys = Object.keys(payload)
  const receiptId = (payload as Record<string, unknown>).receiptId
  if (keys.length !== 1 || keys[0] !== 'receiptId' || typeof receiptId !== 'string' || !receiptId.trim()) {
    throw new Error('Invalid Hostinger inbound task payload: receiptId must be a non-empty string')
  }

  return { receiptId: receiptId.trim() }
}
