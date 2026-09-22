import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { isCanonicalUuid } from '@/lib/uuid'
import {
  createWorkspaceServiceClient,
  workspaceIdForServiceClient,
} from '@/lib/supabase/workspace-service'

const SEED_WORKSPACE_ID = '00000000-0000-0000-0000-000000000001'

function assertAccepted(workspaceId: string): void {
  assert.equal(isCanonicalUuid(workspaceId), true)
  const client = createWorkspaceServiceClient(workspaceId)
  assert.equal(workspaceIdForServiceClient(client), workspaceId)
}

assertAccepted(randomUUID())
assertAccepted(SEED_WORKSPACE_ID)

for (const value of [
  'not-a-uuid',
  '00000000-0000-0000-0000-00000000001',
  '00000000-0000-0000-0000-00000000000g',
  '',
  null,
]) {
  assert.equal(isCanonicalUuid(value), false)
  assert.throws(
    () => createWorkspaceServiceClient(value as string),
    /A valid workspaceId is required/,
  )
}

console.log('WORKSPACE_UUID_VALIDATION_TEST_PASS')
