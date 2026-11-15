# Batch 3 acceptance report

**Recommendation — BLOCKED pending final verification and supported-scope review.**

The dedicated integration branch starts at approved Batch 2 evidence `0f792ae67341bed49d655115aab0f0c378b875e0`. The [implementation register](progress.md) records the baseline and feature disposition. The [commerce contract](contract.md) covers the four operators, workflow version, schemas, APIs, authorization and recovery. [ADR 0009](../adr/0009-commerce-authority.md) records the authority boundaries.

The new commerce module reuses existing SKU rows, order records, stock movements, the G1 Paystack settlement and ledger, shipment controls, the signed WhatsApp outbox and the dashboard. The local checkout and earlier branches are preserved. Commerce is separately enabled for supported retail and custom-order profiles.

## Recorded checkpoints

The original focused run migrated the empty and seeded G1 databases and passed last-unit stock contention. Its signed journey committed the expected quote, order, deposits, balance, shipment and care case. Case resolution returned HTTP 500 because the service passed the full case structure to Prisma as message filter fields. The small correction constructs the exact message scope. In the next run the signed retail, care, consent and custom-pickup journey and contention both passed against fresh PostgreSQL and BullMQ.

An API build initially returned exit 1 from a missing recovery database import. Its corrected build returned exit 0. A subsequent workspace build and typecheck returned exit 0. Default tests returned exit 0 with 991 API and three web passes. The first lint returned exit 1 for seven explicit return-type violations. Types were added to the exported functions. The final build, lint and integration campaign are pending.

The final fixture campaign adds a representative approved Batch 2 workflow and approval before applying the Batch 3 migration. It runs full G1 and Batch 2 regressions, the commerce suite, a fresh repeat, actual Chromium owner controls, compiled smoke, and the backup and application rollback rehearsal.
