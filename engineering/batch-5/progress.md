# Batch 5 continuity and progress

The founder approved G1 and Batches 2–4 for their documented local scopes. The active branch is `codex/batch-5-product`, based on `93a120301eab18f9fae1c151381aa15a5901d022`. GitHub and the local Batch 4 branch matched. The runtime and Prisma files match approved source `98f0022acffa1af3b007e9a2e20f8bd3b1547224`. The separate launch worktree has 44 existing changes and is preserved.

The [product audit](audit.md) records baseline findings. The compiled runtime is `5162d95e5de65bd42e37e772d84c69ba3513f6a5`. The full regression fixtures were verified at `47c5689f7bb45370cf4c273e52ba66d11bc39e7e`. The final product browser fixture was verified at `e22a4996513f6c22d5860dd755e8a662f3336b86`. The source of truth for Batch 5 results and remaining gates is the [acceptance report](report.md). Follow the [milestone register](../milestones.md).

## Founder-approved local scope

| Milestone | Local scope |
| --- | --- |
| [G1](../g1/final-stabilization-report.md) | Durable WhatsApp ingress and outbox, delivery authorization, settlement and payment relationships, stock correctness, assistant grounding, media and echo recovery. |
| [Batch 2](../batch-2/report.md) | Shared tenant-scoped workflow state, evidence and operators, owner approval and safe replay. |
| [Batch 3](../batch-3/closure-report.md) | Quote and stock control, invoicing and settlement, preparation and fulfillment, custody, cases and reminders. |
| [Batch 4](../batch-4/report.md) | Managed leads, service capacity, appointment holds, deposits, assigned staged work, exceptions and approved follow-up. |

The branch connects profile-based setup, overview and Work Center, inbox and support, orders and quotes, service operations, invoices, team and reports. It adds scoped reads and durable replay recovery for the financial and operational forms. Production configuration and Prisma migrations are unchanged. Verify the exact candidate with the [acceptance procedure](report.md), including the earlier platform tests and independent fresh fixtures.

## Resume here

1. Compare Git HEAD with the dedicated remote branch. Preserve the `launch` checkout and existing work. Use the active branch for Batch 5 changes.
2. Start with the [unresolved acceptance items](report.md#open-product-scope) and the corresponding tests in the journey matrix. General inbox assignment and read state, the full legacy control traversal and assistive-technology evidence are separate open product requirements.
3. Reproduce the environment from the [verification commands](report.md#verification-procedure), the [workspace contract](contract.md) and the Batch 3 and 4 fixture references. Use a short-path disposable checkout, fresh local PostgreSQL and Redis, and compiled gateway routes for browser cases.
4. The current authorization covers Batch 5 local implementation, verification and a push to the dedicated branch. Batch 6 covers live provider credentials and independent provider and hosted production verification after separate approval. Provider accounts, real customer data, financial operations and deployment are outside the local acceptance scope.
