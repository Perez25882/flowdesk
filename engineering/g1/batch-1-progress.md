# Batch 1 progress register

The dedicated branch is `codex/g1-batch-1`, based on founder-approved G1-06 record `e4a4021b977a3c843b1e76f5a140827e05eaf593`. The checkout was clean and matched its remote. The tested G1-06 source is `c88c4ddbb66a3a112390e90df49f74d2fb4021c0`. G1-01 through G1-05 are in its ancestry. The separate `launch` checkout remains checked out at `541b7b8`.

| Assignment | Status | Next checkpoint |
| --- | --- | --- |
| G1-00 | Local checks passed | Hosted CI remains unexecuted. |
| G1-07 | Commercial identity and recovery checks passed | Retail quote repeat remains open at the assistant context boundary. |
| G1-08 | Local evidence passed | Rehearse provider callback correlation and legacy job cutover in authorized staging. |
| G1-09 | Local evidence passed for customer status and private proof recovery | Owner low-stock alerts remain best effort before send intent is recorded. |
| G1-10 | Local migration, gateway, rollback and restoration passed | Confirm hosted proxy and startup in authorized staging. |
| Paystack admission and classifier recovery | Local capacity fault, replay and eviction controls passed | The historical intermittent 503 did not have a recorded Prisma code. |
| Cross-system journeys and final gate | BLOCKED for full sign-off | Repeat retail with the diagnostic fixture under controlled capacity pressure and identify the triggering assistant error. |

Implementation checkpoints are `e161fa3`, `ea47b6d`, `a520e68`, `1cf8148`, `1c1ea11`, `de295dd`, `c3d77a3`, `5c04625` and `7e4c434`. The initial full regression recorded 28 assistant cases passing and 367 passing with two failing in the remaining 28 suites. The failures were a concurrent Paystack receipt admission and a bounded classifier scan assertion. The focused rerun on the interactive Paystack code passed 37 cases, including the saturated-pool `P2028` fault and exact retry. The final SQL uses one autocommitted insert and rechecks receipt admission at a deliberately saturated pool.

The runtime source `7e4c434` passed the clean default suite with 991 passing tests and 159 fixture-dependent skips, 53 gateway smoke checks, 29 real-fixture assistant cases and 375 additional regression cases. The binary rollback, roll-forward and post-upgrade evidence restore passed. A later focused repeat exposed one retail inquiry held for explicit review without a recorded model result. Snapshot `e7a0d94` added diagnostics and passed all 37 focused Paystack and retail tests. Detailed commands, intermediate failures and release limits are in the [engineering report](batch-1-report.md).

## Baseline findings

- G1-06 passed 35 dedicated cases on fresh fixtures and 386 targeted cases in the final regression pass. Repository lint exited 1 on the existing web error boundary.
- The smoke runner unconditionally opens a root `.env`, uses the old top-level staff invite token and assumes Starter entitlements during a Business trial. The last group of smoke assertions needs a deterministic Meta token rejection.
- The tracked integration job omits `DIRECT_URL` and starts the API before building the shared package.
- The G1-06 regression recorded an unexplained retryable Paystack admission response during concurrent delivery. The actual Prisma error still needs to be captured.

See the [milestone register](../milestones.md) and [G1-06 verification](whatsapp-media-echo-verification.md).
