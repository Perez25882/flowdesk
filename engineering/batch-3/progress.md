# Batch 3 implementation register

Parent `0f792ae67341bed49d655115aab0f0c378b875e0` matches the fetched Batch 2 branch. Verified runtime `c4d702666902229327c2db25651db80b803efe82`. The integration branch `codex/batch-3-commerce` was created from the approved parent. The source worktree was clean. The separate launch checkout contains 44 existing modified, added, deleted or untracked paths and was inspected read-only.

## Feature disposition at baseline

| Capability | Disposition | Evidence and dependency |
| --- | --- | --- |
| Catalogue, images, SKU and pricing rules | RETAIN and EXTEND | Products and quantity tiers exist. Add independently stocked variants and made-to-order mode. |
| Stock movement on confirmation and cancellation | EXTEND | Existing transactional order transition records movements and low-stock jobs. A stock hold and a floor check are required for contention. |
| Grounded replies and source-bound orders | RETAIN | G1 assistant revalidates current catalogue and links a single inbound source. |
| Accepted commercial quote and amendments | NOT IMPLEMENTED | Batch 2 observes a grounded reply and purchase. It stores no binding itemized offer, reservation or explicit accepted price snapshot. |
| Payments, Paystack settlement and receipts | RETAIN | Existing signed receipt, scoped ledger and independently verified settlement remain authoritative. |
| Invoices, managed deposits and balances | NOT IMPLEMENTED | Checkout links and ledger exist. Add immutable invoice terms and invoice-scoped checkout policy on those services. |
| Dispatch, shipment proof, staff access and notifications | RETAIN and EXTEND | G1 assigns and verifies delivery access. Add preparation, pickup and verified payment release evidence. |
| Status replies, customer review and care | EXTEND | Batch 2 can reply to verified order or payment lookup and open owner review. Structured complaint, return and retention records are missing. |
| Work center, Products, Orders and Payments screens | RETAIN and EXTEND | Use existing screens and permissions to operate new commerce records. |
| Appointment and service workflows | RETAIN | Approved Batch 2 behavior remains part of the regression gate. |

## Increments

1. Quotation and stock authority. Lock the actual saleable SKUs, snapshot terms, expire holds, and convert the accepted quote to the existing order and stock movements.
2. Invoices and payment obligations. Enforce current ledger balance in G1 checkout. Observe verified credits before releasing preparation.
3. Fulfillment and care. Use scoped staff actions, physical evidence, support lifecycle, and consent.
4. Owner commerce controls and signed end-to-end verification. Run the full prior regression and independent fresh fixtures before assigning a gate result.

## Final implementation checkpoint

Implementation `4081a34163be1e4e286aa11d70131a1445bba870` has version 3 quotation, order-linked invoice, fulfillment, support, verified full tracked returns and consent. The fixed-snapshot integration fixture passed the signed retail and custom pickup lifecycle, stock contention, repricing, cancellation, return replay, stale roles and the seeded Batch 2 approval upgrade. The browser fixture uses the actual UI and Fastify API with synthetic settlement data.

Full acceptance is **BLOCKED**. Standalone invoices, independently triggered payment reminders and the dedicated interruption and ambiguous-checkout browser scenarios are open. The [acceptance report](report.md) records exact commands, local results and remaining scope.
