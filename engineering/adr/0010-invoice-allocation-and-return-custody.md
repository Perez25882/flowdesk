# 0010 Invoice allocation and return custody

**Context**

The prior commerce implementation required an order and restored a full tracked return using the order's stock flag. Standalone invoices need an exact financial identity. Partial returns need quantity-level custody that can survive replay and distinguish money, inventory and customer outcomes.

**Decision**

Keep invoice records in the commerce module and add an optional immutable invoice identifier to the existing Paystack initialization, payment request and ledger. PostgreSQL only accepts relationships with matching tenant, customer and nullable order. New amounts reconcile through the existing ledger and independent Paystack verification. Retain the original order relationship for prior invoices and leave historical allocations empty. Keep checkout recovery in PostgreSQL. The browser submits a version derived from that evidence and does not retain it after refresh.

Allocate recovered reminders through invoice-specific sequence identities and the existing durable outbox. Preserve the scheduled deadline, consent and template authority, claim-time balance, transport ambiguity and signed delivery evidence.

Record partial custody per case and order line with a bounded quantity and unique stock movement. Use one order-level lock for full and partial paths and keep financial obligations separate. Case closure consumes current evidence for supported outcomes.

**Consequences**

The schema is additive and retains all original ledger and workflow evidence. Prior binaries can operate historical paths on the new schema under the rollback boundary in the [closure contract](../batch-3/closure-contract.md). Template availability and real provider behavior still require separate live assurance.
