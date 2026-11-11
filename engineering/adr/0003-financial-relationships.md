# ADR 0003 Financial relationships at the ledger boundary

**Status** Implemented for G1-04. Founder sign-off pending.

The payment and payment-request tables originally had independent foreign keys to the business, customer and optional order. A valid foreign key for each column still permitted a row whose order belonged to another customer. The settlement payment ID had uniqueness but no foreign key. PostgreSQL row locks on these identities also provide a common place to serialize balance recomputation.

Validate business, customer, order and staff in the transaction that writes or initializes the payment. Use composite foreign keys for new payment and request identities. Enforce an exact nullable order and reference when linking a settlement. Keep manual payments without an order. Preserve historical rows with `NOT VALID` constraints and a separate read-only audit.

Record owner activity against the business with a null staff ID. Keep existing staff audit queries scoped to staff and record payment mutations and human audit activity in the same transaction. Perform notifications after commit. A payment link takes a bounded provider call while it holds the validated relationship locks, then publishes its URL only after the request commits.

Independent lookups cannot prove the tuple. Immediate validation of every foreign key would make a legacy inconsistency block the migration. Application checks alone would leave other database writers able to create new mismatches. The adopted approach adds indexes and takes migration locks, so production timing must be assessed separately. SQL migration tests cover these constraints and triggers, which Prisma's schema cannot fully express.

Gateway receipt durability, replay, and verification of provider settlement terms remain tracked under G1-03. This decision covers identity of the local request and ledger rows.
