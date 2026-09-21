export interface HostingerInboundTaskPayload {
  receiptId: string
  workspaceId: string
}

export function validateHostingerInboundTaskPayload(payload: unknown): HostingerInboundTaskPayload {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Invalid Hostinger inbound task payload: expected an object')
  }

  const keys = Object.keys(payload)
  const record = payload as Record<string, unknown>
  const receiptId = record.receiptId
  const workspaceId = record.workspaceId
  if (keys.length !== 2 || typeof receiptId !== 'string' || !receiptId.trim()
      || typeof workspaceId !== 'string' || !/^[0-9a-f-]{36}$/i.test(workspaceId)) {
    throw new Error('Invalid Hostinger inbound task payload: receiptId and workspaceId are required')
  }

  return { receiptId: receiptId.trim(), workspaceId }
}
