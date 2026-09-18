# ReachAgent V2 Prompt 17 controlled rollout closeout

Date: 18 September 2026 (Australia/Sydney)

Status: **PROMPT 17 CONTROLLED ROLLOUT PASS**

## Scope

- Workspace: Aussie Venture V2 staging only, branch `reachagent-v2-application`.
- One controlled rollout send using a single pre-staged lead.
- Excluded: Finder, follow-ups, reactivation, Hostinger mutations, Trigger schedules/deployments, batch orchestration, and all V1 access.

## Results

- Prompt 16 one-email canary: **PASS** (recorded earlier on this branch).
- Prompt 17 controlled rollout: **PASS**.
- Real inbox receipt confirmed by the operator.
- Exactly one Prompt 17 provider submission; no retry.
- Durable sent state verified: the staged lead's `initial_pitch` email is `sent`, the lead is `contacted`, the provider ID is present, and there is no `delivery_uncertain` state and no duplicate send.
- Recipient ownership prevented duplicate/shared-recipient sends: the ownership claim persisted for the controlled recipient, so the other two staged leads remained unsent and were removed during closeout.
- All execution gates were restored to `false`; `system_active` was restored to its original (absent) value.

## Safety counters

- V1 reads: **0**
- V1 mutations: **0**
- Finder: **0**
- Hostinger mutations: **0**
- Trigger runs/deployments: **0**
- Provider submissions: **1**

## Known observability gap

The canary runtime persists the decision and executor workflow steps, but the `resend_send` provider-request sub-step is not separately persisted because the initial-send executor does not wrap the provider call in a workflow trace. Durable email state (`sent` + provider ID) remains authoritative.

## Regression

- `npm run typecheck` — PASS
- `npm run build:v2` — PASS
- `npm run test:decision-engine:v2` — PASS
- `npm run test:orchestrator:v2` — PASS
- `npm run test:observability:v2` — PASS
- `npm run test:canary-safety:v2` — PASS

## Cleanup

- Removed the two unsent temporary Prompt 17 leads and their pending email/data-quality artifacts.
- Paused the Prompt 17 test category so it cannot be used for normal outreach.
- Preserved the successful Prompt 17 sent record and all Prompt 16 audit records.
- Removed temporary Prompt 17 staging/preflight/send/cleanup/verification scripts; they are not production code.

## Privacy

No real personal test email, secrets, API keys, or approval tokens are present in this document or introduced by the closeout checkpoint.
