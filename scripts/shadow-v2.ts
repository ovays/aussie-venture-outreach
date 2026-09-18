import { isLeadStatus, type LeadStatus } from '@/lib/lead-status'
import { SHADOW_TARGETS, runShadowReport } from '@/domain/shadow-readiness'
import type { ShadowDifferenceClassification } from '@/domain/decision-engine'

const CLASSIFICATIONS = new Set<ShadowDifferenceClassification>([
  'MATCH', 'EXPECTED_V2_CONSOLIDATION', 'BUG_IN_OLD_LOGIC', 'BUG_IN_NEW_ENGINE', 'PRODUCT_DECISION_REQUIRED',
])

function values(name: string): string[] {
  const output: string[] = []
  for (let index = 2; index < process.argv.length; index++) {
    if (process.argv[index] === name && process.argv[index + 1]) output.push(process.argv[++index])
    else if (process.argv[index].startsWith(`${name}=`)) output.push(process.argv[index].slice(name.length + 1))
  }
  return output
}

function value(name: string): string | undefined { return values(name).at(-1) }
function flag(name: string): boolean { return process.argv.slice(2).includes(name) }
function integer(name: string): number | undefined {
  const raw = value(name)
  if (raw === undefined) return undefined
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} must be an integer.`)
  return parsed
}

async function main() {
  const rawTarget = value('--target')
  if (!rawTarget || !(SHADOW_TARGETS as readonly string[]).includes(rawTarget)) {
    throw new Error(`Explicit --target is required: ${SHADOW_TARGETS.join(', ')}.`)
  }
  const rawStatus = value('--status')
  if (rawStatus && !isLeadStatus(rawStatus)) throw new Error(`Unsupported --status: ${rawStatus}.`)
  const rawClassification = value('--classification')
  if (rawClassification && !CLASSIFICATIONS.has(rawClassification as ShadowDifferenceClassification)) {
    throw new Error(`Unsupported --classification: ${rawClassification}.`)
  }
  const leadIds = values('--lead-id').flatMap((item) => item.split(',')).map((item) => item.trim()).filter(Boolean)
  const report = await runShadowReport({
    safety: { target: rawTarget as (typeof SHADOW_TARGETS)[number], productionReadAcknowledged: flag('--acknowledge-production-read') },
    selector: {
      leadIds: leadIds.length ? leadIds : undefined,
      status: rawStatus as LeadStatus | undefined,
      limit: integer('--limit'),
      recentDays: integer('--recent-days'),
    },
    classification: rawClassification as ShadowDifferenceClassification | undefined,
    concurrency: integer('--concurrency'),
    source: 'cli.shadow-v2',
  })
  console.log(JSON.stringify({
    target: report.target, targetUrl: report.targetUrl,
    observabilityWritesEnabled: report.observabilityWritesEnabled,
    providersEnabled: report.providerCallsEnabled,
    operationalMutationsEnabled: report.operationalMutationsEnabled,
    selected: report.selectedLeadIds.length, contextMetrics: report.contextMetrics,
    readOnlyAudit: report.readOnlyAudit, summary: report.summary,
    results: report.displayedOutcomes,
  }, null, 2))
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
