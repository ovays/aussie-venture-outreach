# ReachAgent V2 real shadow comparison

Date: 2026-09-17 (Australia/Sydney)

Status: **PROMPT 15 PASS**

Approach: sanitized SELECT-only snapshot. The same reviewed read-only statement was
executed twice in total against the V1 target through the operator-run Supabase
Management API database-query path: the first snapshot was deleted after the BOM
validation failure, and the explicitly authorized second execution supplied this
comparison. The statement returned derived Decision Engine facts only. The V1-vs-V2
comparison then ran entirely offline against that snapshot, which was deleted
afterwards. No V1 role, schema, view, policy, function, or key was created.

## Snapshot provenance

| Field | Value |
|---|---|
| Source | production |
| Production SELECT executions | 2 |
| Target identity hash | `ce147b0a6d99bae92dfc7d5c0970f6579be097fa6fdb2a28209a8246790f29c8` |
| Query hash (sha256) | `24ca53b25aeddd6d460baed7194258032ac2ff3ce8ffb2104e3ac222e7eab59a` |
| Executed at | 2026-09-17T12:18:58.7831178+00:00 |
| Rows returned | 100 |
| Snapshot file | `.v2-local/prompt15-real-shadow-snapshot.json` (git-ignored, deleted after comparison) |

## Sample coverage

- Sample size: 100 (hard maximum 100)
- Canonical-status population: 3348
- Leads excluded for a non-canonical status: 0

### Sampled status distribution

- `closed`: 1
- `closed_manual`: 3
- `contacted`: 76
- `dead`: 8
- `email_ready`: 1
- `negotiating`: 1
- `replied`: 5
- `researched`: 5

### Population status totals

- `closed`: 1
- `closed_manual`: 3
- `contacted`: 2918
- `dead`: 177
- `email_ready`: 1
- `negotiating`: 1
- `replied`: 124
- `researched`: 123

### Initial-email mode distribution

- `template`: 100

### Category disposition

- `category_null`: 94
- `category_present`: 6

### Cohort coverage in the sample

- `completed_research`: 100
- `duplicate_or_shared_recipient`: 10
- `fu1_eligible`: 7
- `fu2_eligible`: 16
- `fu3_eligible`: 8
- `manual_source`: 6
- `null_category_id`: 94
- `post_reactivation_window`: 3
- `reactivation_eligible`: 23
- `reply_present`: 5
- `suppression`: 6
- `template_mode`: 100
- `template_ready`: 6

## Classification summary

- `MATCH`: 28
- `EXPECTED_V2_CONSOLIDATION`: 0
- `BUG_IN_OLD_LOGIC`: 0
- `BUG_IN_NEW_ENGINE`: 0
- `PRODUCT_DECISION_REQUIRED`: 72
- Canary blockers: 38

## Non-matching cases

| Lead | Status | Mode | Category | V1 intent | V2 action | Classification | Reason | Canary blocker |
|---|---|---|---|---|---|---|---|---|
| `43be9d73-23c7-41a6-8616-a2ab92303f9f` | contacted | template | null | MANUAL_REVIEW | REACTIVATE (REACTIVATION_READY) | PRODUCT_DECISION_REQUIRED | The difference is not an approved consolidation and must not drive side effects without review. | yes |
| `aa2553c0-29ab-44a8-a23f-f586cfceae3d` | contacted | template | null | MANUAL_REVIEW | REACTIVATE (REACTIVATION_READY) | PRODUCT_DECISION_REQUIRED | The difference is not an approved consolidation and must not drive side effects without review. | yes |
| `255aefb5-9d7e-48f0-b509-1d7bf3cde442` | contacted | template | null | MANUAL_REVIEW | REACTIVATE (REACTIVATION_READY) | PRODUCT_DECISION_REQUIRED | The difference is not an approved consolidation and must not drive side effects without review. | yes |
| `b76c0013-14bd-451f-8c42-0cd93a0b8f31` | contacted | template | null | MANUAL_REVIEW | SEND_FOLLOWUP_3 (FOLLOWUP_3_READY) | PRODUCT_DECISION_REQUIRED | The difference is not an approved consolidation and must not drive side effects without review. | yes |
| `516b4c2d-e4f7-4eb9-9476-732b076e2761` | contacted | template | null | MANUAL_REVIEW | WAIT (REACTIVATION_NOT_DUE) | PRODUCT_DECISION_REQUIRED | The difference is not an approved consolidation and must not drive side effects without review. | no |
| `d5d6296e-5b3e-4de7-ab8c-1b6c076fa6e5` | contacted | template | null | MANUAL_REVIEW | REACTIVATE (REACTIVATION_READY) | PRODUCT_DECISION_REQUIRED | The difference is not an approved consolidation and must not drive side effects without review. | yes |
| `1668cd89-86e7-465b-ad18-6ba12524c974` | contacted | template | null | MANUAL_REVIEW | REACTIVATE (REACTIVATION_READY) | PRODUCT_DECISION_REQUIRED | The difference is not an approved consolidation and must not drive side effects without review. | yes |
| `7ae44f9f-8056-4f19-8f5f-75317b8ac871` | contacted | template | null | MANUAL_REVIEW | SEND_FOLLOWUP_2 (FOLLOWUP_2_READY) | PRODUCT_DECISION_REQUIRED | The difference is not an approved consolidation and must not drive side effects without review. | yes |
| `bed6a39b-3ce0-47ba-b04d-88d519f51237` | contacted | template | null | MANUAL_REVIEW | SEND_FOLLOWUP_2 (FOLLOWUP_2_READY) | PRODUCT_DECISION_REQUIRED | The difference is not an approved consolidation and must not drive side effects without review. | yes |
| `1e9c8b2d-ff61-4c9f-9379-bfe24c887ede` | contacted | template | null | MANUAL_REVIEW | REACTIVATE (REACTIVATION_READY) | PRODUCT_DECISION_REQUIRED | The difference is not an approved consolidation and must not drive side effects without review. | yes |
| `d00480a7-2f24-47d7-bfb2-3c5f29600e17` | contacted | template | null | MANUAL_REVIEW | SEND_FOLLOWUP_1 (FOLLOWUP_1_READY) | PRODUCT_DECISION_REQUIRED | The difference is not an approved consolidation and must not drive side effects without review. | yes |
| `ce4e2100-c32e-42aa-acc1-eba4f62fb11e` | contacted | template | null | MANUAL_REVIEW | WAIT (FOLLOWUP_NOT_DUE) | PRODUCT_DECISION_REQUIRED | The difference is not an approved consolidation and must not drive side effects without review. | no |
| `298b6964-b667-4887-8055-b0af75fa0666` | contacted | template | null | MANUAL_REVIEW | WAIT (FOLLOWUP_NOT_DUE) | PRODUCT_DECISION_REQUIRED | The difference is not an approved consolidation and must not drive side effects without review. | no |
| `d7d23ba0-cf49-4e87-af1c-180c77721cbd` | contacted | template | null | MANUAL_REVIEW | REACTIVATE (REACTIVATION_READY) | PRODUCT_DECISION_REQUIRED | The difference is not an approved consolidation and must not drive side effects without review. | yes |
| `8461f7f3-5052-48cd-89d4-4e8497d4d63a` | contacted | template | null | MANUAL_REVIEW | WAIT (REACTIVATION_NOT_DUE) | PRODUCT_DECISION_REQUIRED | The difference is not an approved consolidation and must not drive side effects without review. | no |
| `ec9b75a0-5a50-4acd-a340-4b4540e4141c` | contacted | template | null | MANUAL_REVIEW | REACTIVATE (REACTIVATION_READY) | PRODUCT_DECISION_REQUIRED | The difference is not an approved consolidation and must not drive side effects without review. | yes |
| `331dd004-8a14-4881-91b3-fb3980e50113` | contacted | template | null | MANUAL_REVIEW | REACTIVATE (REACTIVATION_READY) | PRODUCT_DECISION_REQUIRED | The difference is not an approved consolidation and must not drive side effects without review. | yes |
| `04a70ed4-bfe0-4050-9a0d-69f3b382fc6c` | contacted | template | null | MANUAL_REVIEW | WAIT (REACTIVATION_NOT_DUE) | PRODUCT_DECISION_REQUIRED | The difference is not an approved consolidation and must not drive side effects without review. | no |
| `0485b389-3b92-4b0e-86f8-f66eaf9e957f` | contacted | template | null | MANUAL_REVIEW | WAIT (REACTIVATION_NOT_DUE) | PRODUCT_DECISION_REQUIRED | The difference is not an approved consolidation and must not drive side effects without review. | no |
| `6d02ece9-0f6a-4d87-8346-0a4eb5f15c8f` | contacted | template | null | MANUAL_REVIEW | SEND_FOLLOWUP_2 (FOLLOWUP_2_READY) | PRODUCT_DECISION_REQUIRED | The difference is not an approved consolidation and must not drive side effects without review. | yes |
| `195fe140-1288-45b1-9b42-9435870f187e` | contacted | template | null | MANUAL_REVIEW | SEND_FOLLOWUP_2 (FOLLOWUP_2_READY) | PRODUCT_DECISION_REQUIRED | The difference is not an approved consolidation and must not drive side effects without review. | yes |
| `42a43d94-c412-4133-a838-a0bc63f072bf` | contacted | template | null | MANUAL_REVIEW | SEND_FOLLOWUP_2 (FOLLOWUP_2_READY) | PRODUCT_DECISION_REQUIRED | The difference is not an approved consolidation and must not drive side effects without review. | yes |
| `8eb83e2c-f9c6-4a99-aa71-ab84d205fd8d` | contacted | template | null | MANUAL_REVIEW | WAIT (REACTIVATION_NOT_DUE) | PRODUCT_DECISION_REQUIRED | The difference is not an approved consolidation and must not drive side effects without review. | no |
| `276abb7b-0765-47b5-90e0-cdd2735f45f2` | contacted | template | null | MANUAL_REVIEW | WAIT (FOLLOWUP_NOT_DUE) | PRODUCT_DECISION_REQUIRED | The difference is not an approved consolidation and must not drive side effects without review. | no |
| `8439f825-8b43-4b9e-bd2a-de6e97884bbd` | contacted | template | present | GENERATE_INITIAL | WAIT (REACTIVATION_NOT_DUE) | PRODUCT_DECISION_REQUIRED | The difference is not an approved consolidation and must not drive side effects without review. | no |
| `60a96a2c-17ce-4585-8749-3dca773e5bec` | contacted | template | null | MANUAL_REVIEW | SEND_FOLLOWUP_2 (FOLLOWUP_2_READY) | PRODUCT_DECISION_REQUIRED | The difference is not an approved consolidation and must not drive side effects without review. | yes |
| `c71822d2-e9bc-4578-8a40-b3640e78a1e5` | contacted | template | null | MANUAL_REVIEW | SEND_FOLLOWUP_3 (FOLLOWUP_3_READY) | PRODUCT_DECISION_REQUIRED | The difference is not an approved consolidation and must not drive side effects without review. | yes |
| `e66919d9-1a12-49cd-8560-258e45de3042` | contacted | template | null | MANUAL_REVIEW | REACTIVATE (REACTIVATION_READY) | PRODUCT_DECISION_REQUIRED | The difference is not an approved consolidation and must not drive side effects without review. | yes |
| `1908b22b-f4cc-4f14-a1b4-f41f12e38790` | contacted | template | null | MANUAL_REVIEW | WAIT (REACTIVATION_NOT_DUE) | PRODUCT_DECISION_REQUIRED | The difference is not an approved consolidation and must not drive side effects without review. | no |
| `799d9066-5b97-4a4e-92f0-8498d0bbaa05` | contacted | template | null | MANUAL_REVIEW | WAIT (REACTIVATION_NOT_DUE) | PRODUCT_DECISION_REQUIRED | The difference is not an approved consolidation and must not drive side effects without review. | no |
| `161521e0-5ce3-48db-8cb8-368363e3acaf` | contacted | template | null | MANUAL_REVIEW | SEND_FOLLOWUP_3 (FOLLOWUP_3_READY) | PRODUCT_DECISION_REQUIRED | The difference is not an approved consolidation and must not drive side effects without review. | yes |
| `ea34c08c-b3bb-4125-980b-8c5445847752` | contacted | template | null | MANUAL_REVIEW | REACTIVATE (REACTIVATION_READY) | PRODUCT_DECISION_REQUIRED | The difference is not an approved consolidation and must not drive side effects without review. | yes |
| `80c86986-82ea-4c15-9b4a-a40a6f871be2` | contacted | template | null | MANUAL_REVIEW | SEND_FOLLOWUP_2 (FOLLOWUP_2_READY) | PRODUCT_DECISION_REQUIRED | The difference is not an approved consolidation and must not drive side effects without review. | yes |
| `a45d62ab-f7a3-4d27-98d2-694e7ed55b9a` | contacted | template | null | MANUAL_REVIEW | REACTIVATE (REACTIVATION_READY) | PRODUCT_DECISION_REQUIRED | The difference is not an approved consolidation and must not drive side effects without review. | yes |
| `aaa93a66-6e32-4906-9876-b4f5c2769add` | contacted | template | null | MANUAL_REVIEW | REACTIVATE (REACTIVATION_READY) | PRODUCT_DECISION_REQUIRED | The difference is not an approved consolidation and must not drive side effects without review. | yes |
| `24c11e47-798d-413c-adc2-e3d6cb699ebd` | contacted | template | null | MANUAL_REVIEW | SEND_FOLLOWUP_1 (FOLLOWUP_1_READY) | PRODUCT_DECISION_REQUIRED | The difference is not an approved consolidation and must not drive side effects without review. | yes |
| `84986286-79a1-45e7-ab82-a8700f05a14e` | contacted | template | null | MANUAL_REVIEW | WAIT (FOLLOWUP_NOT_DUE) | PRODUCT_DECISION_REQUIRED | The difference is not an approved consolidation and must not drive side effects without review. | no |
| `7b640b4b-9439-42ca-a2b9-4703f87e469a` | contacted | template | null | MANUAL_REVIEW | WAIT (FOLLOWUP_NOT_DUE) | PRODUCT_DECISION_REQUIRED | The difference is not an approved consolidation and must not drive side effects without review. | no |
| `f1efa5e7-7e2a-45f9-a378-aaf112057788` | contacted | template | null | MANUAL_REVIEW | SEND_FOLLOWUP_2 (FOLLOWUP_2_READY) | PRODUCT_DECISION_REQUIRED | The difference is not an approved consolidation and must not drive side effects without review. | yes |
| `82ff0048-47ad-4408-a3dd-a3e6f1ac4f96` | contacted | template | null | MANUAL_REVIEW | WAIT (REACTIVATION_NOT_DUE) | PRODUCT_DECISION_REQUIRED | The difference is not an approved consolidation and must not drive side effects without review. | no |
| `502a326f-8ab9-4083-80a5-f0fe4ed68c5a` | contacted | template | null | MANUAL_REVIEW | REACTIVATE (REACTIVATION_READY) | PRODUCT_DECISION_REQUIRED | The difference is not an approved consolidation and must not drive side effects without review. | yes |
| `6dd0135d-bff8-4470-958f-7382fab3315a` | contacted | template | null | MANUAL_REVIEW | WAIT (REACTIVATION_NOT_DUE) | PRODUCT_DECISION_REQUIRED | The difference is not an approved consolidation and must not drive side effects without review. | no |
| `7c92e0b0-992b-4297-9095-32b81614feb0` | contacted | template | null | MANUAL_REVIEW | WAIT (REACTIVATION_NOT_DUE) | PRODUCT_DECISION_REQUIRED | The difference is not an approved consolidation and must not drive side effects without review. | no |
| `3998fae6-63ec-4dcb-81fb-63a6856318fb` | contacted | template | null | MANUAL_REVIEW | SEND_FOLLOWUP_3 (FOLLOWUP_3_READY) | PRODUCT_DECISION_REQUIRED | The difference is not an approved consolidation and must not drive side effects without review. | yes |
| `bcb8d17f-ef97-49c5-9f28-79b6fa262f20` | contacted | template | present | GENERATE_INITIAL | WAIT (REACTIVATION_NOT_DUE) | PRODUCT_DECISION_REQUIRED | The difference is not an approved consolidation and must not drive side effects without review. | no |
| `fac340db-03c4-438e-bb8c-b960b468dacc` | contacted | template | null | MANUAL_REVIEW | WAIT (FOLLOWUP_NOT_DUE) | PRODUCT_DECISION_REQUIRED | The difference is not an approved consolidation and must not drive side effects without review. | no |
| `67171858-c9b9-470d-a6fa-0267f1ce862c` | contacted | template | null | MANUAL_REVIEW | WAIT (REACTIVATION_NOT_DUE) | PRODUCT_DECISION_REQUIRED | The difference is not an approved consolidation and must not drive side effects without review. | no |
| `877f7824-3c1c-4013-8f8c-c3a4e940e305` | contacted | template | null | MANUAL_REVIEW | WAIT (FOLLOWUP_NOT_DUE) | PRODUCT_DECISION_REQUIRED | The difference is not an approved consolidation and must not drive side effects without review. | no |
| `337821e0-fe56-4dbc-aff4-6cc2a31ff612` | contacted | template | null | MANUAL_REVIEW | REACTIVATE (REACTIVATION_READY) | PRODUCT_DECISION_REQUIRED | The difference is not an approved consolidation and must not drive side effects without review. | yes |
| `8991598c-50ea-4a8a-a54c-dc6c63de08f0` | contacted | template | null | MANUAL_REVIEW | REACTIVATE (REACTIVATION_READY) | PRODUCT_DECISION_REQUIRED | The difference is not an approved consolidation and must not drive side effects without review. | yes |
| `d46b6fbd-00ac-487b-8489-1f716a0f2eda` | contacted | template | null | MANUAL_REVIEW | SEND_FOLLOWUP_2 (FOLLOWUP_2_READY) | PRODUCT_DECISION_REQUIRED | The difference is not an approved consolidation and must not drive side effects without review. | yes |
| `e1cde839-143a-4757-b048-e4f23c1fd999` | contacted | template | null | MANUAL_REVIEW | WAIT (REACTIVATION_NOT_DUE) | PRODUCT_DECISION_REQUIRED | The difference is not an approved consolidation and must not drive side effects without review. | no |
| `e407e962-3669-4164-82a5-da8e93e71c78` | contacted | template | null | MANUAL_REVIEW | REACTIVATE (REACTIVATION_READY) | PRODUCT_DECISION_REQUIRED | The difference is not an approved consolidation and must not drive side effects without review. | yes |
| `2a0390b4-bfa6-4657-b0dc-4e91c2de5451` | contacted | template | null | MANUAL_REVIEW | SEND_FOLLOWUP_1 (FOLLOWUP_1_READY) | PRODUCT_DECISION_REQUIRED | The difference is not an approved consolidation and must not drive side effects without review. | yes |
| `82688925-7ff2-4a20-accd-dc58788ccfd3` | contacted | template | null | MANUAL_REVIEW | WAIT (FOLLOWUP_NOT_DUE) | PRODUCT_DECISION_REQUIRED | The difference is not an approved consolidation and must not drive side effects without review. | no |
| `c0bebf6d-bba5-4bb0-ba47-448d7c60a9b6` | contacted | template | null | MANUAL_REVIEW | WAIT (FOLLOWUP_NOT_DUE) | PRODUCT_DECISION_REQUIRED | The difference is not an approved consolidation and must not drive side effects without review. | no |
| `7be951f1-2ce0-4595-867d-cfecf7223c03` | contacted | template | null | MANUAL_REVIEW | SEND_FOLLOWUP_2 (FOLLOWUP_2_READY) | PRODUCT_DECISION_REQUIRED | The difference is not an approved consolidation and must not drive side effects without review. | yes |
| `3bd715c3-2472-4515-95fd-282067975f98` | contacted | template | null | MANUAL_REVIEW | WAIT (REACTIVATION_NOT_DUE) | PRODUCT_DECISION_REQUIRED | The difference is not an approved consolidation and must not drive side effects without review. | no |
| `f6b574be-810a-44c6-8669-f88dcce53fc1` | contacted | template | null | MANUAL_REVIEW | WAIT (REACTIVATION_NOT_DUE) | PRODUCT_DECISION_REQUIRED | The difference is not an approved consolidation and must not drive side effects without review. | no |
| `b2e0963f-42a4-4788-b16c-e72e89af5531` | contacted | template | null | MANUAL_REVIEW | WAIT (REACTIVATION_NOT_DUE) | PRODUCT_DECISION_REQUIRED | The difference is not an approved consolidation and must not drive side effects without review. | no |
| `7c5f3bbc-9098-4de5-8369-a7e72cc76d85` | contacted | template | null | MANUAL_REVIEW | SEND_FOLLOWUP_1 (FOLLOWUP_1_READY) | PRODUCT_DECISION_REQUIRED | The difference is not an approved consolidation and must not drive side effects without review. | yes |
| `b20d1d30-a7d7-4795-92a3-980e9e730d12` | contacted | template | null | MANUAL_REVIEW | REACTIVATE (REACTIVATION_READY) | PRODUCT_DECISION_REQUIRED | The difference is not an approved consolidation and must not drive side effects without review. | yes |
| `abdad1c7-e179-4163-a97e-aa002c671080` | contacted | template | present | GENERATE_INITIAL | WAIT (REACTIVATION_NOT_DUE) | PRODUCT_DECISION_REQUIRED | The difference is not an approved consolidation and must not drive side effects without review. | no |
| `5961a60d-1137-4ed7-907e-1e14b08d8a21` | contacted | template | null | MANUAL_REVIEW | WAIT (REACTIVATION_NOT_DUE) | PRODUCT_DECISION_REQUIRED | The difference is not an approved consolidation and must not drive side effects without review. | no |
| `57a3a78b-2863-402e-96e0-94038edcb966` | contacted | template | null | MANUAL_REVIEW | WAIT (REACTIVATION_NOT_DUE) | PRODUCT_DECISION_REQUIRED | The difference is not an approved consolidation and must not drive side effects without review. | no |
| `a12a3a40-ac00-4a81-913c-01b5b9968390` | contacted | template | null | MANUAL_REVIEW | SEND_FOLLOWUP_2 (FOLLOWUP_2_READY) | PRODUCT_DECISION_REQUIRED | The difference is not an approved consolidation and must not drive side effects without review. | yes |
| `3d8e4fa7-e5e7-4f62-a793-19176194c816` | contacted | template | null | MANUAL_REVIEW | WAIT (FOLLOWUP_NOT_DUE) | PRODUCT_DECISION_REQUIRED | The difference is not an approved consolidation and must not drive side effects without review. | no |
| `85739da3-f1b4-4b1f-b62e-bf0507ed1044` | contacted | template | null | MANUAL_REVIEW | WAIT (REACTIVATION_NOT_DUE) | PRODUCT_DECISION_REQUIRED | The difference is not an approved consolidation and must not drive side effects without review. | no |
| `fdc0a3d2-0ba2-46cc-b934-05314427e30e` | contacted | template | null | MANUAL_REVIEW | REACTIVATE (REACTIVATION_READY) | PRODUCT_DECISION_REQUIRED | The difference is not an approved consolidation and must not drive side effects without review. | yes |
| `ac9b10ba-4b93-4844-8604-253318de8d7d` | contacted | template | null | MANUAL_REVIEW | WAIT (FOLLOWUP_NOT_DUE) | PRODUCT_DECISION_REQUIRED | The difference is not an approved consolidation and must not drive side effects without review. | no |
| `310bada5-8f9d-44de-8d53-50d51646c99c` | contacted | template | null | MANUAL_REVIEW | WAIT (REACTIVATION_NOT_DUE) | PRODUCT_DECISION_REQUIRED | The difference is not an approved consolidation and must not drive side effects without review. | no |
| `efd1b6e2-502a-4518-9768-8b00bc20d7c1` | contacted | template | present | GENERATE_INITIAL | WAIT (FOLLOWUP_NOT_DUE) | PRODUCT_DECISION_REQUIRED | The difference is not an approved consolidation and must not drive side effects without review. | no |

## Rule verification

| # | Rule | Result | Evidence |
|---|---|---|---|
| 1 | duplicate/suppression precedence | PASS | Duplicate and suppression STOP ahead of reply, deal, follow-up, and terminal handling. |
| 2 | terminal state handling | PASS | closed, closed_manual, dead, and a closed deal all STOP with TERMINAL_STATUS. |
| 3 | reply handling | PASS | Replies hand off before follow-up scheduling; unsubscribe stops and out-of-office waits. |
| 4 | interested/negotiating/closed handling | PASS | Active-deal statuses STOP without any outbound action. |
| 5 | template-ready flow | PASS | Template mode generates only when the template and its required data are both present. |
| 6 | personalised research flow | PASS | Personalised mode researches first, then generates, and stops when no address exists. |
| 7 | email_ready + pending initial => SEND_INITIAL | PASS | A pending initial pitch is sent, never regenerated; email_ready without content needs review. |
| 8 | FU1 = 7 days from initial | PASS | Day 6 waits, day 7 sends follow-up 1, measured from the initial send. |
| 9 | FU2 = 14 days from initial | PASS | Follow-up 2 is due at 14 days from the initial send, not from follow-up 1. |
| 10 | FU3 = 21 days from initial | PASS | Follow-up 3 is due at 21 days from the initial send. |
| 11 | reactivation = 60 days from initial send | PASS | Reactivation is measured 60 days from the initial send; disabled reactivation ends the sequence instead. |
| 12 | post-reactivation dead threshold = 14 days | PASS | Day 13 after reactivation waits; day 14 marks the lead dead. |
| 13 | send uncertainty => MANUAL_REVIEW | PASS | Unresolved email_sync_failed sends always stop for review instead of resending. |
| 14 | null category handling | PASS | Null-category leads never reach template generation (94 sampled instances). |
| 15 | no GENERATE_FOLLOWUP | PASS | GENERATE_FOLLOWUP does not exist; follow-ups are a single send action carrying contentReady. |
| 16 | template-ready path remains zero-AI | PASS | Template-ready leads generate deterministically with no AI step (6 sampled instances). |

## Unresolved cases

- 43be9d73-23c7-41a6-8616-a2ab92303f9f: PRODUCT_DECISION_REQUIRED — V1 MANUAL_REVIEW vs V2 REACTIVATE (REACTIVATION_READY)
- aa2553c0-29ab-44a8-a23f-f586cfceae3d: PRODUCT_DECISION_REQUIRED — V1 MANUAL_REVIEW vs V2 REACTIVATE (REACTIVATION_READY)
- 255aefb5-9d7e-48f0-b509-1d7bf3cde442: PRODUCT_DECISION_REQUIRED — V1 MANUAL_REVIEW vs V2 REACTIVATE (REACTIVATION_READY)
- b76c0013-14bd-451f-8c42-0cd93a0b8f31: PRODUCT_DECISION_REQUIRED — V1 MANUAL_REVIEW vs V2 SEND_FOLLOWUP_3 (FOLLOWUP_3_READY)
- 516b4c2d-e4f7-4eb9-9476-732b076e2761: PRODUCT_DECISION_REQUIRED — V1 MANUAL_REVIEW vs V2 WAIT (REACTIVATION_NOT_DUE)
- d5d6296e-5b3e-4de7-ab8c-1b6c076fa6e5: PRODUCT_DECISION_REQUIRED — V1 MANUAL_REVIEW vs V2 REACTIVATE (REACTIVATION_READY)
- 1668cd89-86e7-465b-ad18-6ba12524c974: PRODUCT_DECISION_REQUIRED — V1 MANUAL_REVIEW vs V2 REACTIVATE (REACTIVATION_READY)
- 7ae44f9f-8056-4f19-8f5f-75317b8ac871: PRODUCT_DECISION_REQUIRED — V1 MANUAL_REVIEW vs V2 SEND_FOLLOWUP_2 (FOLLOWUP_2_READY)
- bed6a39b-3ce0-47ba-b04d-88d519f51237: PRODUCT_DECISION_REQUIRED — V1 MANUAL_REVIEW vs V2 SEND_FOLLOWUP_2 (FOLLOWUP_2_READY)
- 1e9c8b2d-ff61-4c9f-9379-bfe24c887ede: PRODUCT_DECISION_REQUIRED — V1 MANUAL_REVIEW vs V2 REACTIVATE (REACTIVATION_READY)
- d00480a7-2f24-47d7-bfb2-3c5f29600e17: PRODUCT_DECISION_REQUIRED — V1 MANUAL_REVIEW vs V2 SEND_FOLLOWUP_1 (FOLLOWUP_1_READY)
- ce4e2100-c32e-42aa-acc1-eba4f62fb11e: PRODUCT_DECISION_REQUIRED — V1 MANUAL_REVIEW vs V2 WAIT (FOLLOWUP_NOT_DUE)
- 298b6964-b667-4887-8055-b0af75fa0666: PRODUCT_DECISION_REQUIRED — V1 MANUAL_REVIEW vs V2 WAIT (FOLLOWUP_NOT_DUE)
- d7d23ba0-cf49-4e87-af1c-180c77721cbd: PRODUCT_DECISION_REQUIRED — V1 MANUAL_REVIEW vs V2 REACTIVATE (REACTIVATION_READY)
- 8461f7f3-5052-48cd-89d4-4e8497d4d63a: PRODUCT_DECISION_REQUIRED — V1 MANUAL_REVIEW vs V2 WAIT (REACTIVATION_NOT_DUE)
- ec9b75a0-5a50-4acd-a340-4b4540e4141c: PRODUCT_DECISION_REQUIRED — V1 MANUAL_REVIEW vs V2 REACTIVATE (REACTIVATION_READY)
- 331dd004-8a14-4881-91b3-fb3980e50113: PRODUCT_DECISION_REQUIRED — V1 MANUAL_REVIEW vs V2 REACTIVATE (REACTIVATION_READY)
- 04a70ed4-bfe0-4050-9a0d-69f3b382fc6c: PRODUCT_DECISION_REQUIRED — V1 MANUAL_REVIEW vs V2 WAIT (REACTIVATION_NOT_DUE)
- 0485b389-3b92-4b0e-86f8-f66eaf9e957f: PRODUCT_DECISION_REQUIRED — V1 MANUAL_REVIEW vs V2 WAIT (REACTIVATION_NOT_DUE)
- 6d02ece9-0f6a-4d87-8346-0a4eb5f15c8f: PRODUCT_DECISION_REQUIRED — V1 MANUAL_REVIEW vs V2 SEND_FOLLOWUP_2 (FOLLOWUP_2_READY)
- 195fe140-1288-45b1-9b42-9435870f187e: PRODUCT_DECISION_REQUIRED — V1 MANUAL_REVIEW vs V2 SEND_FOLLOWUP_2 (FOLLOWUP_2_READY)
- 42a43d94-c412-4133-a838-a0bc63f072bf: PRODUCT_DECISION_REQUIRED — V1 MANUAL_REVIEW vs V2 SEND_FOLLOWUP_2 (FOLLOWUP_2_READY)
- 8eb83e2c-f9c6-4a99-aa71-ab84d205fd8d: PRODUCT_DECISION_REQUIRED — V1 MANUAL_REVIEW vs V2 WAIT (REACTIVATION_NOT_DUE)
- 276abb7b-0765-47b5-90e0-cdd2735f45f2: PRODUCT_DECISION_REQUIRED — V1 MANUAL_REVIEW vs V2 WAIT (FOLLOWUP_NOT_DUE)
- 8439f825-8b43-4b9e-bd2a-de6e97884bbd: PRODUCT_DECISION_REQUIRED — V1 GENERATE_INITIAL vs V2 WAIT (REACTIVATION_NOT_DUE)
- 60a96a2c-17ce-4585-8749-3dca773e5bec: PRODUCT_DECISION_REQUIRED — V1 MANUAL_REVIEW vs V2 SEND_FOLLOWUP_2 (FOLLOWUP_2_READY)
- c71822d2-e9bc-4578-8a40-b3640e78a1e5: PRODUCT_DECISION_REQUIRED — V1 MANUAL_REVIEW vs V2 SEND_FOLLOWUP_3 (FOLLOWUP_3_READY)
- e66919d9-1a12-49cd-8560-258e45de3042: PRODUCT_DECISION_REQUIRED — V1 MANUAL_REVIEW vs V2 REACTIVATE (REACTIVATION_READY)
- 1908b22b-f4cc-4f14-a1b4-f41f12e38790: PRODUCT_DECISION_REQUIRED — V1 MANUAL_REVIEW vs V2 WAIT (REACTIVATION_NOT_DUE)
- 799d9066-5b97-4a4e-92f0-8498d0bbaa05: PRODUCT_DECISION_REQUIRED — V1 MANUAL_REVIEW vs V2 WAIT (REACTIVATION_NOT_DUE)
- 161521e0-5ce3-48db-8cb8-368363e3acaf: PRODUCT_DECISION_REQUIRED — V1 MANUAL_REVIEW vs V2 SEND_FOLLOWUP_3 (FOLLOWUP_3_READY)
- ea34c08c-b3bb-4125-980b-8c5445847752: PRODUCT_DECISION_REQUIRED — V1 MANUAL_REVIEW vs V2 REACTIVATE (REACTIVATION_READY)
- 80c86986-82ea-4c15-9b4a-a40a6f871be2: PRODUCT_DECISION_REQUIRED — V1 MANUAL_REVIEW vs V2 SEND_FOLLOWUP_2 (FOLLOWUP_2_READY)
- a45d62ab-f7a3-4d27-98d2-694e7ed55b9a: PRODUCT_DECISION_REQUIRED — V1 MANUAL_REVIEW vs V2 REACTIVATE (REACTIVATION_READY)
- aaa93a66-6e32-4906-9876-b4f5c2769add: PRODUCT_DECISION_REQUIRED — V1 MANUAL_REVIEW vs V2 REACTIVATE (REACTIVATION_READY)
- 24c11e47-798d-413c-adc2-e3d6cb699ebd: PRODUCT_DECISION_REQUIRED — V1 MANUAL_REVIEW vs V2 SEND_FOLLOWUP_1 (FOLLOWUP_1_READY)
- 84986286-79a1-45e7-ab82-a8700f05a14e: PRODUCT_DECISION_REQUIRED — V1 MANUAL_REVIEW vs V2 WAIT (FOLLOWUP_NOT_DUE)
- 7b640b4b-9439-42ca-a2b9-4703f87e469a: PRODUCT_DECISION_REQUIRED — V1 MANUAL_REVIEW vs V2 WAIT (FOLLOWUP_NOT_DUE)
- f1efa5e7-7e2a-45f9-a378-aaf112057788: PRODUCT_DECISION_REQUIRED — V1 MANUAL_REVIEW vs V2 SEND_FOLLOWUP_2 (FOLLOWUP_2_READY)
- 82ff0048-47ad-4408-a3dd-a3e6f1ac4f96: PRODUCT_DECISION_REQUIRED — V1 MANUAL_REVIEW vs V2 WAIT (REACTIVATION_NOT_DUE)
- 502a326f-8ab9-4083-80a5-f0fe4ed68c5a: PRODUCT_DECISION_REQUIRED — V1 MANUAL_REVIEW vs V2 REACTIVATE (REACTIVATION_READY)
- 6dd0135d-bff8-4470-958f-7382fab3315a: PRODUCT_DECISION_REQUIRED — V1 MANUAL_REVIEW vs V2 WAIT (REACTIVATION_NOT_DUE)
- 7c92e0b0-992b-4297-9095-32b81614feb0: PRODUCT_DECISION_REQUIRED — V1 MANUAL_REVIEW vs V2 WAIT (REACTIVATION_NOT_DUE)
- 3998fae6-63ec-4dcb-81fb-63a6856318fb: PRODUCT_DECISION_REQUIRED — V1 MANUAL_REVIEW vs V2 SEND_FOLLOWUP_3 (FOLLOWUP_3_READY)
- bcb8d17f-ef97-49c5-9f28-79b6fa262f20: PRODUCT_DECISION_REQUIRED — V1 GENERATE_INITIAL vs V2 WAIT (REACTIVATION_NOT_DUE)
- fac340db-03c4-438e-bb8c-b960b468dacc: PRODUCT_DECISION_REQUIRED — V1 MANUAL_REVIEW vs V2 WAIT (FOLLOWUP_NOT_DUE)
- 67171858-c9b9-470d-a6fa-0267f1ce862c: PRODUCT_DECISION_REQUIRED — V1 MANUAL_REVIEW vs V2 WAIT (REACTIVATION_NOT_DUE)
- 877f7824-3c1c-4013-8f8c-c3a4e940e305: PRODUCT_DECISION_REQUIRED — V1 MANUAL_REVIEW vs V2 WAIT (FOLLOWUP_NOT_DUE)
- 337821e0-fe56-4dbc-aff4-6cc2a31ff612: PRODUCT_DECISION_REQUIRED — V1 MANUAL_REVIEW vs V2 REACTIVATE (REACTIVATION_READY)
- 8991598c-50ea-4a8a-a54c-dc6c63de08f0: PRODUCT_DECISION_REQUIRED — V1 MANUAL_REVIEW vs V2 REACTIVATE (REACTIVATION_READY)
- d46b6fbd-00ac-487b-8489-1f716a0f2eda: PRODUCT_DECISION_REQUIRED — V1 MANUAL_REVIEW vs V2 SEND_FOLLOWUP_2 (FOLLOWUP_2_READY)
- e1cde839-143a-4757-b048-e4f23c1fd999: PRODUCT_DECISION_REQUIRED — V1 MANUAL_REVIEW vs V2 WAIT (REACTIVATION_NOT_DUE)
- e407e962-3669-4164-82a5-da8e93e71c78: PRODUCT_DECISION_REQUIRED — V1 MANUAL_REVIEW vs V2 REACTIVATE (REACTIVATION_READY)
- 2a0390b4-bfa6-4657-b0dc-4e91c2de5451: PRODUCT_DECISION_REQUIRED — V1 MANUAL_REVIEW vs V2 SEND_FOLLOWUP_1 (FOLLOWUP_1_READY)
- 82688925-7ff2-4a20-accd-dc58788ccfd3: PRODUCT_DECISION_REQUIRED — V1 MANUAL_REVIEW vs V2 WAIT (FOLLOWUP_NOT_DUE)
- c0bebf6d-bba5-4bb0-ba47-448d7c60a9b6: PRODUCT_DECISION_REQUIRED — V1 MANUAL_REVIEW vs V2 WAIT (FOLLOWUP_NOT_DUE)
- 7be951f1-2ce0-4595-867d-cfecf7223c03: PRODUCT_DECISION_REQUIRED — V1 MANUAL_REVIEW vs V2 SEND_FOLLOWUP_2 (FOLLOWUP_2_READY)
- 3bd715c3-2472-4515-95fd-282067975f98: PRODUCT_DECISION_REQUIRED — V1 MANUAL_REVIEW vs V2 WAIT (REACTIVATION_NOT_DUE)
- f6b574be-810a-44c6-8669-f88dcce53fc1: PRODUCT_DECISION_REQUIRED — V1 MANUAL_REVIEW vs V2 WAIT (REACTIVATION_NOT_DUE)
- b2e0963f-42a4-4788-b16c-e72e89af5531: PRODUCT_DECISION_REQUIRED — V1 MANUAL_REVIEW vs V2 WAIT (REACTIVATION_NOT_DUE)
- 7c5f3bbc-9098-4de5-8369-a7e72cc76d85: PRODUCT_DECISION_REQUIRED — V1 MANUAL_REVIEW vs V2 SEND_FOLLOWUP_1 (FOLLOWUP_1_READY)
- b20d1d30-a7d7-4795-92a3-980e9e730d12: PRODUCT_DECISION_REQUIRED — V1 MANUAL_REVIEW vs V2 REACTIVATE (REACTIVATION_READY)
- abdad1c7-e179-4163-a97e-aa002c671080: PRODUCT_DECISION_REQUIRED — V1 GENERATE_INITIAL vs V2 WAIT (REACTIVATION_NOT_DUE)
- 5961a60d-1137-4ed7-907e-1e14b08d8a21: PRODUCT_DECISION_REQUIRED — V1 MANUAL_REVIEW vs V2 WAIT (REACTIVATION_NOT_DUE)
- 57a3a78b-2863-402e-96e0-94038edcb966: PRODUCT_DECISION_REQUIRED — V1 MANUAL_REVIEW vs V2 WAIT (REACTIVATION_NOT_DUE)
- a12a3a40-ac00-4a81-913c-01b5b9968390: PRODUCT_DECISION_REQUIRED — V1 MANUAL_REVIEW vs V2 SEND_FOLLOWUP_2 (FOLLOWUP_2_READY)
- 3d8e4fa7-e5e7-4f62-a793-19176194c816: PRODUCT_DECISION_REQUIRED — V1 MANUAL_REVIEW vs V2 WAIT (FOLLOWUP_NOT_DUE)
- 85739da3-f1b4-4b1f-b62e-bf0507ed1044: PRODUCT_DECISION_REQUIRED — V1 MANUAL_REVIEW vs V2 WAIT (REACTIVATION_NOT_DUE)
- fdc0a3d2-0ba2-46cc-b934-05314427e30e: PRODUCT_DECISION_REQUIRED — V1 MANUAL_REVIEW vs V2 REACTIVATE (REACTIVATION_READY)
- ac9b10ba-4b93-4844-8604-253318de8d7d: PRODUCT_DECISION_REQUIRED — V1 MANUAL_REVIEW vs V2 WAIT (FOLLOWUP_NOT_DUE)
- 310bada5-8f9d-44de-8d53-50d51646c99c: PRODUCT_DECISION_REQUIRED — V1 MANUAL_REVIEW vs V2 WAIT (REACTIVATION_NOT_DUE)
- efd1b6e2-502a-4518-9768-8b00bc20d7c1: PRODUCT_DECISION_REQUIRED — V1 GENERATE_INITIAL vs V2 WAIT (FOLLOWUP_NOT_DUE)

## Privacy

The snapshot carried only allow-listed derived facts. The automated scan in
`scripts/prompt15-snapshot-safety.ts` rejected every field outside the allowlist and
searched all string values for email addresses, URLs, and phone-like sequences. No
email address, business name, phone, address, raw city, website, subject, body,
template text, activity metadata, prompt, AI response, provider message ID, or
credential left V1. This report contains opaque lead IDs only.

## Activity counters

- V1 mutations: 0
- V1 schema changes: 0
- V1 grant changes: 0
- V1 policy changes: 0
- V2 operational mutations: 0
- Sends: 0
- AI calls: 0
- Finder runs: 0
- Hostinger mutations: 0
- Trigger deployments/runs: 0
- Snapshot deleted: yes

## Prompt 16 decision

Prompt 16 cannot safely start. Although Prompt 15 passes because all 16 rules pass
and `BUG_IN_NEW_ENGINE` is zero, 38 `PRODUCT_DECISION_REQUIRED` differences could
produce V2 side effects and must be resolved before a canary begins.
