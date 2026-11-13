# G1-04 payment, order and customer consistency

## Financial integrity contract

- A payment or hosted request belongs to one business and one customer of that business. An optional order must exist in that business and belong to that exact customer. A foreign, missing or archived reference returns 404 for new payment effects. A same-business order for a different customer returns 400.
- A no-order payment is a customer-level credit or refund. It changes the customer balance without allocating funds to an order. No-order hosted links and screenshot claims remain supported. Confirming a claim with the order omitted retains the current link. An explicit null confirms it without an order.
- An authenticated owner is identified by their business. Staff must be active in the business and have the required capability. Human writes create activity with the business and optional staff ID in the same transaction. Ledger attestation and void fields keep the existing owner marker. An automated link records no human activity, and gateway attestation records Paystack.
- A settlement link must match the ledger payment's business, customer, order including null, and reference. Only non-voided, attested amounts contribute to order and customer balances. Recalculation filters by the validated relationship, and keeps the existing net-of-refunds and negative-credit behavior.

## Workflows and transaction boundaries

| Path | Transaction and effect |
| --- | --- |
| Manual payment or refund | Lock and validate the customer and optional order, write the ledger, refresh eligible totals, and write actor activity. Receipt and realtime notifications run after commit. Refunds do not send a receipt for incoming money. |
| Screenshot claim | Lock the tenant and image identity, validate customer ownership, and record or return one unverified claim. Archive attachment is scoped to the business, customer and image key. |
| Claim confirmation or attestation | Serialize on the customer and claim, then validate the effective order. Commit the one-time confidence change, totals and activity together. A placeholder claim must be confirmed with an amount. |
| Void | Validate the existing relationship, reverse its contribution, and record the reason and actor atomically. A consistent archived relationship may be voided. Repeating a void or confirmation produces no second financial effect. |
| Hosted link | Validate actor and relationship under lock before the provider call. Reuse an open same-business, same-customer, same-order link for the same amount. Commit the new request and human activity together, then optionally send it. Separate no-order requests keep their existing semantics. |
| Gateway callback | The G1-03 worker verifies the durable receipt and revalidates the local relationship. It commits the ledger, balances, settlement linkage and completion together. See the [gateway settlement contract](paystack-settlement.md). |
| Link cancellation and expiry | Human cancellation rechecks the linked customer and order, preserves the ledger and records the actor. The expiry job only closes pending requests by time. |

The customer row serializes balance recomputation before aggregates are read. Order locks serialize the financial write with order changes. The provider client bounds hosted initialization to ten seconds and the link transaction has a fifteen-second timeout. G1-03 records the initialization intent before the provider call and holds ambiguous references for review. Compare provider and local state before any authorized disposition. See the [recovery runbook](paystack-settlement.md#tenant-scoped-runbook).

Manual entries have no request idempotency key. Each successful entry records its own payment. Claim, void, screenshot and order-linked request retries use their existing identities.

## Migration and reconciliation

The existing single-column foreign keys continue to cover basic existence. Migration `20261111090000_financial_relationships` adds composite keys on customer/order/ledger identity, `NOT VALID` foreign keys, settlement identity triggers, and business attribution on the activity table. Historical payments and links retain their original columns and activity remains readable. Runtime validation checks archival state, which ordinary foreign keys do not encode. The workflow uses soft deletion for financial records and their orders.

Review generated Prisma migrations for changes to the SQL-managed foreign keys, checks and triggers. Preserve those protections when changing related tables.

Run the [read-only audit](../../apps/api/scripts/audit-payment-relationships.sql) using a disposable fixture or a separately authorized read-only database. The query returns row and business IDs and a reason code. Review mismatched orders, cross-tenant associations and inconsistent settlement links against source evidence. Preserve original evidence and make any reconciliation a separately approved operation. Keep the new constraints in place while reviewing legacy rows. Validate them only after authorized reconciliation eliminates the violations.

PostgreSQL migration and server changes belong in the same release. A failed migration rolls back its transaction. Rolling back application code after a successful migration can reintroduce the old actor-attribution defect, and database protections still reject new mismatched writes. Rehearse rollback and review any pending provider references before a release decision. Production migration lock duration and live Paystack behavior are unverified.
