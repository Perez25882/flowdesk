# Batch 1 durable effect and delivery boundaries

**Status** Implemented in the Batch 1 integration candidate. See the verification record for acceptance status.

Use the original inbound message ID for an order or appointment created from that message. PostgreSQL serializes customer and source mutations and enforces one order source ID and one appointment assistant source ID. Preserve the existing business policy checks and slot exclusion constraint. Use an optional client-issued idempotency key for manual ledger entry, scoped to the business and bound to the actor and normalized input.

PostgreSQL owns outbound authorization and delivery evidence. BullMQ schedules send attempts from that state. Ambiguous provider outcomes require a matching authenticated status or operator review. An opaque callback value correlates provider evidence with a local attempt. It does not deduplicate provider requests.

Fulfillment transactions own shipment, order history and the pending notification or proof-cleanup task. Object storage and provider messages are outside the transaction. An orphaned storage key is eligible for idempotent cleanup after the staged object lease. Status notification retries converge on a durable outbound event key.

The locally rehearsed gateway routes the built SPA and Fastify under one HTTP origin. A release process applies additive migrations before running matching workers. A rollback preserves the database and durable state for recovery.

[Batch contracts and recovery](../g1/batch-1-contract.md)
