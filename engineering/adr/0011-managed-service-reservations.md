# ADR 0011 – Managed service reservations

**Status** Integration candidate. Local sign-off is tracked in the [Batch 4 register](../batch-4/progress.md).

## Context

The existing diary reserves an appointment lane. Service businesses also need to reserve staff and equipment across service definitions, quote immutable terms, await approval or verified deposits, and prove what staff completed. Payment allocation, customer ownership, outbound delivery evidence and recovery already have enforcing boundaries.

## Decision

Attach a service visit to the existing appointment. Persist resource claims, a policy snapshot, an optional exact Batch 3 invoice, and attendance and execution evidence. Service mutations serialize by customer and tenant calendar, then use the existing appointment constraints and a PostgreSQL exclusion constraint over staff and equipment ranges. A held visit owns capacity before confirmation.

Pin service work to version 4 of the existing workflow engine. Use the existing finance and outbound paths for provider effects. Preserve the source of each fact, including signed customer commands, independently verified settlements, staff attestations and provider delivery receipts. Late financial evidence enters review without changing the released reservation.

## Consequences

Historical appointments keep their original write path. The managed calendar rejects stale prices and unavailable slots without touching existing commitments. Valid provider requests can settle after service hold expiry and may require an owner adjustment. A prior binary cannot execute version 4 or revalidate the new outbound authorizations. Apply the [rollback boundary](../batch-4/service-contract.md#rollback-and-recovery).
