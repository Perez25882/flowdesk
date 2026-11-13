# FlowDesk engineering

This directory contains the versioned engineering record. It is separate from the private, ignored `docs/` directory in existing checkouts.

| Record                                                     | Purpose                                                              |
| ---------------------------------------------------------- | -------------------------------------------------------------------- |
| [G0 source and verification baseline](g0/baseline.md)      | Source selection, preserved work, commands, results and reproduction |
| [G0 architecture and inventory](g0/architecture.md)        | Runtime topology, integration boundaries and data ownership          |
| [Five operators and feature disposition](g0/operators.md)  | Current journeys, disposition and gaps                               |
| [G0 defect register](g0/defects.md)                        | Reproductions, source findings, impact and priority                  |
| [Milestone register and G1 assignments](milestones.md)     | Gates, dependencies and acceptance tests                             |
| [Architecture decisions](adr/README.md)                    | Accepted constraints and decisions awaiting approval                 |
| [G1-01 WhatsApp text ingress](g1/whatsapp-text-ingress.md) | Workflow contract, migration and recovery                            |
| [G1-01 verification](g1/verification.md)                   | Executed commands, results and boundaries                            |
| [G1-02 delivery authorization](g1/delivery-authorization.md) | Role contract, shipment workflow and threat model                  |
| [G1-02 verification](g1/delivery-authorization-verification.md) | Baseline, executed checks and remaining limitations              |
| [G1-03 Paystack settlement](g1/paystack-settlement.md) | Gateway contract, transaction boundaries and recovery runbook |
| [G1-03 verification](g1/paystack-settlement-verification.md) | Migration, recovery, regression and smoke evidence |
| [G1-04 payment relationships](g1/payment-relationships.md) | Financial contract, transactions and reconciliation                  |
| [G1-04 verification](g1/payment-relationships-verification.md) | Migration, integration and repository results                       |

## Engineering conventions

- Preserve worktree and branch state. Base changes on an explicitly recorded commit. Bring existing local edits into scope only by identifying the intended diff and reviewing it independently.
- Keep one owner interface. Use existing web pages and components, query hooks, the shared API client and server-sent events. Enforce authorization in Fastify and the business service, including actor assignment and tenant identity.
- Keep rules in existing domain modules and shared contracts. A model response is untrusted input. Use server-resolved identifiers, verified evidence and typed actions for commitments about money, availability, delivery and customer data.
- Specify a business outcome for each workflow. Record the actor, tenant, resource, correlation key and explicit outcome. Persist completion evidence, what a waiting state depends on, or the reason and recovery path for failure. Queue acceptance and provider delivery are separate milestones.
- Use Postgres for business truth and consistency. Use BullMQ/Redis for scheduling, retry and fan-out. Specify the idempotency key, retry horizon and transaction boundary at every external handoff. Separate durable audit state from SSE and logs.
- Test success, failure after partial progress, replay and concurrency where applicable. Exercise actual Postgres constraints for financial, stock, booking and tenancy invariants. Add UI tests for owner-facing states. Use synthetic fixtures, loopback services and mocked provider transport.
- Update the relevant workflow documentation, ADR and milestone in the same change. Record exact commands, exit status, counts and gaps. Validate additive migrations on an empty database and a representative synthetic upgrade. Record rollback and reconciliation procedures before release.
- Keep runtime configuration and credentials outside Git. Require explicit founder approval before any production access or deployment. Use existing dependencies unless a change has a documented technical reason and cost review.
