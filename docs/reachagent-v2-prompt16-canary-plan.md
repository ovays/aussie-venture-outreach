# ReachAgent V2 Prompt 16 tiny Aussie Venture canary plan

Date: 17 September 2026 (Australia/Sydney)

Status: **prerequisite implementation complete and locally verified; real canary execution remains blocked pending separate approval.**

Source plan: `~/.commandcode/plans/prompt-16-tiny-v2-canary.md`

Phase 0 checkpoint commit: `a2fcd54` on `reachagent-v2-application`.

## Scope

- Workspace: Aussie Venture V2 only.
- First execution: exactly one real lead.
- Action: `SEND_INITIAL` only (`INITIAL_CONTENT_READY`).
- `maxIterations: 1`.
- Excluded: Finder, broad pipeline, queue/status/category/city selection, generation chaining, follow-ups, reactivation, lifecycle marking, Hostinger, recurring Trigger schedules, and V1 access.

## Runtime gates

All eight V2 execution gates remain false in `.env.v2.local`. The canary uses three additional fail-closed controls (`V2_CANARY_ENABLED`, `V2_CANARY_LEAD_IDS`, operator approval) that remain false/empty by default.

## Implemented prerequisites

1. **Strict one-ID canary policy/parser** — `src/lib/v2-canary-safety.ts`. Rejects absent, empty, malformed, duplicate, and more-than-one allowlist IDs. Asserts the exact canary environment and single-run contract.
2. **Two-phase approval/content hash** — `src/lib/v2-canary-approval.ts`. Immutable SHA-256 over recipient, sender, subject, HTML, text, intent ID, and phase; redacted preview; operator approval bound to lead, recipient fingerprint, content hash, intent, and sender.
3. **V2 env schema** — `src/lib/env.ts` and `.env.v2.example` add `REACHAGENT_ENV`, canary gates, and a V2-scoped `RESEND_API_KEY_V2`.
4. **Provider boundary** — `src/lib/resend.ts` enforces canary allowlist + `initial_pitch` immediately before provider submission and requires a V2-scoped Resend credential during canary.
5. **Atomic send claim and durable uncertainty** — `src/lib/outbound-send.ts` and `src/services/outbound/send-initial-outreach.ts`. Conditional `pending_send -> sending` claim, persisted immutable envelope, and `sending -> sent|failed|delivery_uncertain` transitions. On uncertainty the intent is frozen, never reset to `pending_send`.
6. **Dedicated manual entry** — `src/lib/v2-canary-runtime.ts` and `scripts/run-v2-canary.ts`. Preview (read-only) and execute phases; Decision Engine must return exactly `SEND_INITIAL`; observability writes `v2_initial_send_canary` with decision, executor, and provider steps.
7. **Orchestrator fail-closed guards** — `src/domain/orchestrator/runtime.ts` blocks broad batches and non-canary workflows while canary is enabled.
8. **Narrow `v2_canary` deployment validation** — `src/lib/v2-runtime-safety.ts` permits only the exact canary gate combination with a one-ID allowlist.
9. **Migration** — `supabase-v2/migrations/00000000000003_v2_canary_send_claim.sql` adds `sending`/`delivery_uncertain` states, the immutable `send_envelope`, `claimed_at`, and the tightened lead/phase uniqueness guard.
10. **Tests** — `scripts/test-v2-canary-safety.ts` covers allowlist parsing, environment/phase/provider-boundary fail-closed behavior, content-hash determinism, approval binding, and the atomic claim decision.

## Verification

| Check | Result |
|---|---|
| `typecheck` | PASS |
| `test:canary-safety:v2` | PASS |
| `test:decision-engine:v2` | PASS |
| `test:prompt15-safety-gate:v2` | PASS |
| `test:shadow-readiness:v2` | PASS |
| `test:deployment-safety:v2` | PASS |
| `test:orchestrator:v2` | PASS |
| `test:agent-consolidation:v2` | PASS |
| `test:observability:v2` | PASS |
| `test:resend-send-idempotency` | PASS |
| `test:duplicate-followup-prevention` | PASS |
| `test:hosted-safety:v2` | Not run locally (requires hosted identifiers) |

## Production safety counters

Production access, V1 mutations, V2 operational mutations, sends, AI calls, Finder, Hostinger mutations, and Trigger deployments/runs: **0**.

## Execution gate

Real canary execution remains **blocked**. The next step is separate operator approval to select one Aussie Venture lead and open the controlled flag window (`V2_CANARY_ENABLED`, `ORCHESTRATOR_ENABLED`, `OUTREACH_SEND_ENABLED`) for exactly one `SEND_INITIAL` attempt.
