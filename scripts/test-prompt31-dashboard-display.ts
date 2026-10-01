import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { workspaceExecutionLabel, workspaceRoleLabel } from '../src/lib/workspace-display'

const source = (path: string) => readFileSync(resolve(path), 'utf8')

assert.equal(workspaceExecutionLabel({ systemActive: false, mailboxConnected: true, onboardingCompleted: true }), 'Paused', 'paused workspace does not display Live')
assert.equal(workspaceExecutionLabel({ systemActive: true, mailboxConnected: false, onboardingCompleted: true }), 'Paused', 'disconnected mailbox does not display Live')
assert.equal(workspaceExecutionLabel({ systemActive: true, mailboxConnected: true, onboardingCompleted: false }), 'Paused', 'incomplete onboarding does not display Live')
assert.equal(workspaceExecutionLabel({ systemActive: true, mailboxConnected: true, onboardingCompleted: true }), 'Live', 'Live requires every readiness condition')

assert.equal(workspaceRoleLabel('owner'), 'Workspace Owner')
assert.equal(workspaceRoleLabel('admin'), 'Workspace Admin')
assert.equal(workspaceRoleLabel('member'), 'Workspace Member')

const dashboard = source('src/app/dashboard/page.tsx')
const statusServer = source('src/lib/workspace-display-server.ts')
const layout = source('src/app/dashboard/layout.tsx')
const sidebar = source('src/components/layout/Sidebar.tsx')

assert.doesNotMatch(dashboard, /Live · Sydney/, 'dashboard no longer hard-codes Live or Sydney')
assert.match(dashboard, /getWorkspaceStatusDisplay\(workspace\.workspaceId\)/, 'dashboard resolves status from the active workspace')
assert.match(statusServer, /systemActive:[\s\S]*mailboxConnected:[\s\S]*onboardingCompleted:/, 'status combines system, mailbox, and onboarding state')
assert.match(statusServer, /\.eq\('status', 'connected'\)/, 'only a connected mailbox satisfies readiness')
assert.match(layout, /workspaceRole = workspace\.role/, 'customer shell passes the resolved active membership role')
assert.match(sidebar, /role === 'admin' \? 'Platform admin'/, 'platform-admin label remains unchanged')
assert.match(sidebar, /workspaceRoleLabel\(workspaceRole\)/, 'customer label uses workspace membership role')

console.log('Prompt 3.1 dashboard display tests passed')
