# Batch 1 durable effect and delivery boundaries

**Status** Implemented in the Batch 1 integration candidate. See the verification record for acceptance status.

Use the original inbound message ID for an order or appointment created from that message. PostgreSQL serializes customer and source mutations and enforces one order source ID and one appointment assistant source ID. Preserve the existing business policy checks and slot exclusion constraint. Use an optional client-issued idempotency key for manual ledger entry, scoped to the business and bound to the actor and normalized input.

PostgreSQL owns outbound authorization and delivery evidence. BullMQ schedules send attempts from that state. Ambiguous provider outcomes require a matching authenticated status or operator review. An opaque callback value correlates provider evidence with a local attempt. It does not deduplicate provider requests.

A worker that already has one outbound job waits for the short PostgreSQL lock on that specific send row. The scheduler can hold the row while recording its handoff. PostgreSQL rechecks eligibility after the lock is released. Global recovery scans still skip locked rows. A completed queue job cannot be mistaken for a provider attempt.

Fulfillment transactions own shipment, order history and the pending notification or proof-cleanup task. Object storage and provider messages are outside the transaction. An orphaned storage key is eligible for idempotent cleanup after the staged object lease. Status notification retries converge on a durable outbound event key.

The stock transaction records the owner-alert task on a downward reorder-level crossing. The stock movement identifies the task and the outbound handoff. A restock above the threshold rearms the next crossing. The existing recovery worker resolves current stock and owner preferences before scheduling, and the outbound worker checks the owner recipient and preference again.

Durable classification evidence and downstream effect evidence have separate checkpoints. A stopped or expired classification effect enters review unless the existing order recovery can prove and safely replay its effect. Assistant reads may retry a known transient database error within the same turn before a business effect starts. Authority, model result, grounded outbound intent, and delivery evidence remain independently observable.

The dashboard saves one request identity and its submitted data in actor-, tenant-, and order-scoped tab storage before the first ledger POST. A successful response clears that request. An ambiguous response retains it for confirmation using the original key and input. Distinct completed manual actions receive distinct keys.

The locally rehearsed gateway routes the built SPA and Fastify under one HTTP origin. A release process applies additive migrations before running matching workers. A rollback preserves the database and durable state for recovery.

[Batch contracts and recovery](../g1/batch-1-contract.md)
