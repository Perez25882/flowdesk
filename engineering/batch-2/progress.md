# Batch 2 progress

## Source and scope

Integration branch `codex/batch-2-execution-platform` starts at `fe411b5541127d172c352e47fa6c67521f2ee3b8`, the clean approved G1 branch and its fetched remote head. The verified G1 application is `84c92ac0c5c70bad0b6c9d28e7ea15688ef33d4d`. The separate launch checkout has staged and unstaged changes and was inspected with read-only Git commands. See the [G1 baseline](../g1/final-stabilization-report.md).

| Increment | Evidence |
| --- | --- |
| A and B | Implemented. PostgreSQL workflow tables, admission, pinned versions, history and bounded due-row scheduler. |
| C and F | Implemented for signed text, grounded quote and order, hosted checkout and settlement, appointment, shipment and customer notification. |
| D and E | Implemented profile presets, owner control and a verified status approval with execution-time validation. |
| G and H | Implemented owner reads and commands and the dashboard work center. Verified the final release gates and the independent repeat. |

## Verification

The final source is `c4d702666902229327c2db25651db80b803efe82`. Build, typecheck, lint, 994 default tests, 417 full regression tests and 43 fresh repeat tests passed. Both compiled smoke runs passed 53 checks, including the approved G1 binary against the migrated schema. Chromium approval, backup and restore also passed. The [acceptance report](report.md) records exact commands and initial failures. Batch 2 is ready for founder review of its verified local scope.
