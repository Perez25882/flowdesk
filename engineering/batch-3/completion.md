# Batch 3 completion register

The founder authorized all remaining Batch 3 workstreams. The dedicated branch `codex/batch-3-completion` starts at `cd84165bb50f958971fa7864b549ee1c322888e6`, which matched the fetched GitHub branch. The reported implementation `4081a34163be1e4e286aa11d70131a1445bba870` matches that revision for application and Prisma files. Both descend from approved Batch 2 parent `0f792ae67341bed49d655115aab0f0c378b875e0`. The launch worktree remains separate.

| Workstream | State | Evidence required |
| --- | --- | --- |
| A. Standalone invoices | Passing focused checkpoint | Real signed payments allocated to exact invoices. Two obligations for the same customer stayed independent. The prior Batch 3 fixture preserved order-linked settlement and return evidence. |
| B. Reminders | Passing focused checkpoint | Approved template, partial balance, provider ambiguity, queue eviction and signed delivery passed on the second disposable fixture. Signed opt-out and final-source verification remain scheduled. |
| C. Partial returns | Passing integration checkpoint | Quantity fence, staff custody, owner approval, inventory restoration, signed exchange and separate refund evidence. |
| D. Payment release recovery | Passing integration checkpoint | Actual process termination and replay around verification, commit, preparation, evidence and queue boundaries. Includes interrupted balance settlement after a real deposit. |
| E. Checkout refresh | Passed compiled Chromium | Payment-link recovery uses invoice-scoped PostgreSQL state and a ledger-version precondition. The browser recovered the same request after reload and refused stale and ambiguous retries. |
| F. Media admission | Passing integration checkpoint | Deliberate single-connection pool exhaustion produced retryable responses with redacted diagnostics. Exact replay admitted one receipt and a foreign collision was quarantined. |
| G. Owner browser | Passed compiled Chromium | Mobile owner operated variant, order, pickup, case, partial return, invoice, reminder and checkout controls. |
| H. Integration | Final suite and repeat pending | Initial complete regression passed 434 cases. The corrected candidate reruns the complete G1, Batch 2 and Batch 3 gate. |
| I. Migration and recovery | Passing migration and restore checkpoint | 38 migrations on empty, approved Batch 2 upgrade, and prior Batch 3 seeded upgrade. Historical and final commerce database backup and restore passed. Final binary rollback and roll-forward remain scheduled. |

The prior [Batch 3 report](report.md) retains historical evidence. New checks use locally generated identities and disposable loopback services.

## Checkpoints

- The first staged app snapshot passed `pnpm db:generate`, `pnpm build`, `pnpm typecheck`, `pnpm lint`, empty migration and seeded Batch 2 migration. Its two fixture tests failed. A Paystack fixture tried to mutate serialized metadata without decoding it, and the media diagnostic expectation allowed only one Prisma acquisition code. The second run parses transport metadata as JSON and checks the narrow set of actual pool acquisition errors.
- The second snapshot passed generation, build, typecheck, lint and deployment of 38 migrations on all three database histories. This snapshot covers the original closure workflows. Later refinements and the expanded browser test require a fresh build and fixture run before release.
- Initial complete snapshot `80de361` passed 434 integration and regression cases. Runtime `73c99c2` adds an obsolete-link guard and wakes waiting reminders after template verification. Fixed test snapshot `3d13718` passed the frozen install, static and default gates, the full Chromium fixture and final commerce backup/restore. The [completion evidence](closure-report.md) tracks final smoke and integration.
