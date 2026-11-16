# Batch 3 completion register

The founder authorized all remaining Batch 3 workstreams. The dedicated branch `codex/batch-3-completion` starts at `cd84165bb50f958971fa7864b549ee1c322888e6`, which matched the fetched GitHub branch. The reported implementation `4081a34163be1e4e286aa11d70131a1445bba870` matches that revision for application and Prisma files. Both descend from approved Batch 2 parent `0f792ae67341bed49d655115aab0f0c378b875e0`. The launch worktree remains separate.

| Workstream | State | Evidence required |
| --- | --- | --- |
| A. Standalone invoices | Passing focused checkpoint | Real signed payments allocated to exact invoices. Two obligations for the same customer stayed independent. The prior Batch 3 fixture preserved order-linked settlement and return evidence. |
| B. Reminders | Passing focused checkpoint | Approved template, partial balance, provider ambiguity, queue eviction and signed delivery passed on the second disposable fixture. Signed opt-out and final-source verification remain scheduled. |
| C. Partial returns | Implemented, focused suite running | Quantity fence, staff custody, owner approval, inventory restoration and separate financial obligations. |
| D. Payment release recovery | Implemented, focused suite running | Actual process termination and replay around commit, preparation and notification boundaries. |
| E. Checkout refresh | Implemented, Chromium pending | Payment-link recovery uses invoice-scoped PostgreSQL state and a ledger-version precondition. |
| F. Media admission | Instrumented, focused suite running | Structured Prisma and PostgreSQL codes. Deliberate single-connection pool exhaustion uses three signed simultaneous admissions and exact retries. |
| G. Owner browser | Expanded fixture, pending | Compiled mobile owner navigation, variant, order, partial return, invoice and checkout interruption. |
| H. Integration | Pending | Final G1, Batch 2, Batch 3 and fresh repeat results. |
| I. Migration and recovery | Passing migration checkpoint | 38 migrations deployed on empty, approved Batch 2 upgrade, and prior Batch 3 seeded upgrade. Baseline PostgreSQL dump and restore passed. Final binary rollback and roll-forward remain scheduled. |

The prior [Batch 3 report](report.md) retains historical evidence. New checks use locally generated identities and disposable loopback services.

## Checkpoints

- The first staged app snapshot passed `pnpm db:generate`, `pnpm build`, `pnpm typecheck`, `pnpm lint`, empty migration and seeded Batch 2 migration. Its two fixture tests failed. A Paystack fixture tried to mutate serialized metadata without decoding it, and the media diagnostic expectation allowed only one Prisma acquisition code. The second run parses transport metadata as JSON and checks the narrow set of actual pool acquisition errors.
- The second snapshot passed generation, build, typecheck, lint and deployment of 38 migrations on all three database histories. This snapshot covers the original closure workflows. Later refinements and the expanded browser test require a fresh build and fixture run before release.
