# ADR 0001 — Shared execution and trusted business services

- **Date** 2026-11-09
- **Status** Accepted scope constraints from the G0 kickoff

## Context

FlowDesk already has one React dashboard, Fastify application, Prisma data model and BullMQ worker pipeline. The approved operators all act on the same customers, orders, appointments, payments and conversations. Their responsibilities cross commercial and security boundaries.

## Decision

Keep the existing repository and one shared execution platform and owner interface. Operators organize business responsibilities. Trusted tenant-scoped services enforce authorization and domain invariants before any action. AI interprets and proposes. Existing runtime components remain the starting point wherever justified. Each workflow defines how it verifies completion, waits for a named condition, or recovers from failure.

## Alternatives considered

Separate runtimes and interfaces would introduce identity, state synchronization and support work across operators. A rebuild would discard existing product and test coverage before the shared workflows are validated.

## Consequences

Operators share identities, business records and status semantics. Preserve useful existing behavior and close reliability gaps at the shared boundaries first. The exact orchestration, deployment and workflow persistence designs are subject to later review.
