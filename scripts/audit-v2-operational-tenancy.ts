import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import ts from 'typescript'

const root = resolve(import.meta.dirname, '..')
const tenantTables = new Set([
  'activity_log', 'ai_request_logs', 'categories', 'category_email_templates',
  'category_suburb_priorities', 'category_suburb_search_state', 'city_suburbs',
  'dead_letter_queue', 'deals', 'discovery_run_metrics', 'distributed_locks',
  'dm_queue', 'emails', 'exhausted_queries', 'follow_ups', 'inbound_receipts',
  'lead_data_quality_flags', 'leads', 'recipient_outreach_ownership', 'search_cache',
  'workflow_runs', 'workflow_steps', 'workspace_settings',
])
const workspaceRpcs = new Set([
  'claim_hostinger_inbound_receipt', 'claim_recipient_outreach', 'insert_finder_lead_if_new',
  'lookup_finder_candidates', 'refresh_email_group_quality', 'refresh_lead_data_quality',
  'release_recipient_outreach_claim', 'remove_data_quality_emails',
  'set_data_quality_flag_status', 'suppress_lead_delivery_email',
])

const roots = [
  'agents', 'trigger', 'src/ai', 'src/domain/decision-engine', 'src/domain/orchestrator',
  'src/services', 'src/app/api',
]
const operationalLibs = new Set([
  'analytics.ts', 'create-lead.ts', 'data-quality.ts', 'deduplication.ts',
  'distributed-lock.ts', 'email-status.ts', 'hostinger-inbound-receipts.ts',
  'initial-email-mode-snapshot.ts', 'initial-email-router.ts', 'outbound-send.ts',
  'process-researched-lead.ts', 'research-lead.ts', 'searchBusinesses.ts',
  'stored-sequence-templates.ts', 'v2-canary-runtime.ts', 'write-lead.ts',
])

function walk(path: string): string[] {
  return readdirSync(path).flatMap((name) => {
    const child = resolve(path, name)
    return statSync(child).isDirectory() ? walk(child) : /\.(?:ts|tsx)$/.test(name) ? [child] : []
  })
}

const files = roots.flatMap((path) => walk(resolve(root, path)))
  .concat([...operationalLibs].map((name) => resolve(root, 'src/lib', name)))
const findings: string[] = []

function literal(node: ts.Node | undefined): string | undefined {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined
}

function fromTable(expression: ts.Expression): string | undefined {
  if (!ts.isCallExpression(expression) || !ts.isPropertyAccessExpression(expression.expression)) return undefined
  if (expression.expression.name.text !== 'from') return undefined
  return literal(expression.arguments[0])
}

for (const file of files) {
  const source = readFileSync(file, 'utf8')
  const display = relative(root, file).replaceAll('\\', '/')
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)

  if (source.includes('createServiceClient(') && !source.includes('createWorkspaceServiceClient(')) {
    const rawTenantAccess = [...tenantTables].some((table) => source.includes(`from('${table}')`) || source.includes(`from("${table}")`))
    const exempt = display.endsWith('src/lib/workspace-settings.ts') || display.endsWith('src/lib/workspace-context.ts')
      || display.endsWith('src/lib/auth.ts')
    if (rawTenantAccess && !exempt) findings.push(`${display}: service-role tenant access is not created through createWorkspaceServiceClient`)
  }

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const operation = node.expression.name.text
      const table = fromTable(node.expression.expression)
      if (table && tenantTables.has(table) && (operation === 'insert' || operation === 'upsert')) {
        const rowText = node.arguments[0]?.getText(ast) ?? ''
        if (!/\bworkspace_id\b|\bworkspaceRows?\s*\(/.test(rowText)) {
          const { line } = ast.getLineAndCharacterOfPosition(node.getStart(ast))
          findings.push(`${display}:${line + 1}: ${operation} into ${table} does not explicitly supply workspace_id`)
        }
        if (operation === 'upsert') {
          const options = node.arguments[1]?.getText(ast) ?? ''
          if (!/onConflict\s*:\s*['"][^'"]*workspace_id/.test(options)) {
            const { line } = ast.getLineAndCharacterOfPosition(node.getStart(ast))
            findings.push(`${display}:${line + 1}: upsert into ${table} lacks a workspace-scoped conflict target`)
          }
        }
      }
      if (operation === 'rpc') {
        const rpc = literal(node.arguments[0])
        if (rpc && workspaceRpcs.has(rpc)) {
          const args = node.arguments[1]?.getText(ast) ?? ''
          if (!/\bp_workspace_id\b/.test(args) && !(ts.isIdentifier(node.arguments[1]) && source.includes('p_workspace_id'))) {
            const { line } = ast.getLineAndCharacterOfPosition(node.getStart(ast))
            findings.push(`${display}:${line + 1}: operational RPC ${rpc} lacks p_workspace_id`)
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
}

for (const migration of ['00000000000009_workspace_scope_functions_and_keys.sql', '00000000000010_remove_workspace_default.sql']) {
  assert(statSync(resolve(root, 'supabase-v2/migrations', migration)).isFile(), `${migration} is required`)
}

if (findings.length) {
  console.error(`OPERATIONAL_TENANCY_AUDIT_FAIL count=${findings.length}`)
  for (const finding of findings) console.error(finding)
  process.exitCode = 1
} else {
  console.log('OPERATIONAL_TENANCY_AUDIT_PASS count=0')
}
