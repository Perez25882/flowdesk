# Batch 2 progress

## Source and scope

Integration branch `codex/batch-2-execution-platform` starts at `fe411b5541127d172c352e47fa6c67521f2ee3b8`, the clean approved G1 branch and its fetched remote head. The verified G1 application is `84c92ac0c5c70bad0b6c9d28e7ea15688ef33d4d`. The separate launch checkout has staged and unstaged changes and was inspected with read-only Git commands. See the [G1 baseline](../g1/final-stabilization-report.md).

| Increment | Evidence |
| --- | --- |
| A and B | Implemented. PostgreSQL workflow tables, admission, pinned versions, history and bounded due-row scheduler. |
| C and F | Implemented for signed text, grounded quote and order, hosted checkout and settlement, appointment, shipment and customer notification. |
| D and E | Implemented profile presets, owner control and a verified status approval with execution-time validation. |
| G and H | Implemented owner reads and commands and the dashboard work center. Running the final verification campaign. |

## Verification

See the [acceptance report](report.md). Finish the full fresh G1 regression, fresh Batch 2 repeat, compiled smoke, browser check and migrated backup and rollback rehearsal. Record exact test counts and any blockers before requesting founder review.
