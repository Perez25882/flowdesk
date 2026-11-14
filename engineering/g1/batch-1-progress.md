# Batch 1 progress register

The dedicated branch is `codex/g1-batch-1`, based on founder-approved G1-06 record `e4a4021b977a3c843b1e76f5a140827e05eaf593`. The checkout was clean and matched its remote. The tested G1-06 source is `c88c4ddbb66a3a112390e90df49f74d2fb4021c0`. G1-01 through G1-05 are in its ancestry. The separate `launch` checkout remains checked out at `541b7b8`.

| Assignment | Status | Next checkpoint |
| --- | --- | --- |
| G1-00 | In progress | Repair smoke and CI, then verify against fresh local PostgreSQL and Redis. |
| G1-07 | Pending | Trace transaction boundaries around order creation, pending-order resolution and booking. |
| G1-08 | Pending | Trace outbound producers, draft approval, provider attempts, and authenticated status callbacks. |
| G1-09 | Pending | Trace order and shipment transactions, storage writes and notifications. |
| G1-10 | Pending | Rehearse local release, migration, readiness, backup and restoration after integration. |
| Paystack admission and classifier recovery | Pending | Reproduce the original concurrent receipt failure and exercise a lost classifier job with durable ingress. |
| Cross-system journeys and final gate | Pending | Run all supported journeys from disposable fixtures after the implementation checkpoints. |

## Baseline findings

- G1-06 passed 35 dedicated cases on fresh fixtures and 386 targeted cases in the final regression pass. Repository lint exited 1 on the existing web error boundary.
- The smoke runner unconditionally opens a root `.env`, uses the old top-level staff invite token and assumes Starter entitlements during a Business trial. The last group of smoke assertions needs a deterministic Meta token rejection.
- The tracked integration job omits `DIRECT_URL` and starts the API before building the shared package.
- The G1-06 regression recorded an unexplained retryable Paystack admission response during concurrent delivery. The actual Prisma error still needs to be captured.

See the [milestone register](../milestones.md) and [G1-06 verification](whatsapp-media-echo-verification.md).
