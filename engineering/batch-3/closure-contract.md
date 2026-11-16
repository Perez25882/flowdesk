# Batch 3 completion contract

This contract extends the [original commerce contract](contract.md) and the [completion register](completion.md). The application continues to use one G1 ledger, one durable outbound queue and version 3 of the shared workflow engine for retail order handoffs.

## Invoices and exact allocation

The owner can create a GHS standalone invoice draft from the Commerce panel. A tenant-scoped identifier, customer, quantity and approved unit amount are recorded with the terms and due day. Amounts are entered in pesewas and the server computes totals. Issuing freezes the terms. An existing retail quote issues its linked invoice at order acceptance. Standalone invoices support an explicitly selected partial amount and subsequent balance checkout. Existing deposits and order release rules continue to apply to linked invoices.

Payment requests, initialization intents and payments carry the optional invoice ID. PostgreSQL enforces tenant and customer identity, checks exact nullable order agreement, and prevents retroactive reassignment. Initialization and settlement links must agree with that allocation. Signed callbacks admit receipts. Independent verification supplies the provider identity, currency, exact request amount and invoice metadata before settlement. The existing G1 transaction records the payment, request, provider transaction and receipt. Existing allocation-free customer credits remain unallocated. Historical order-linked records are found through their original tenant, customer and order. Historical relationships remain in place.

A standalone invoice reads its paid amount from independently settled incoming credits and recorded outbound adjustments. An authorized owner records an actual external refund as an attributed and audited OUT ledger entry. This reduces paid balance and does not initiate money movement. G1 voids preserve the original entry and reason. Cancelling an obligation closes pending requests, retains paid history and leaves subsequent provider evidence for review. An order-linked invoice retains the original quote and price contract. The customer receives the existing verified-payment receipt with standalone invoice reference and remaining balance when the business enables receipts and an eligible channel exists.

The signed Paystack metadata and database allocation must refer to the same invoice. A duplicate provider transaction, crossed invoice, wrong account, expired request, interrupted checkout or materially changed amount reaches the existing reconciliation rules. See [ADR 0010](../adr/0010-invoice-allocation-and-return-custody.md).

## Checkout and reload recovery

The browser loads the invoice checkout state and server-derived version. It submits the version with a scoped request and keeps it in memory. The relationship lock serializes equivalent checkout attempts. An in-flight initialization and existing pending request are recoverable from the invoice after refresh. The checkout version changes after a ledger or closed-request change, so a stale action cannot become a new charge. If an order total or available balance changes, an obsolete pending link is removed from the view and the invoice enters payment review. The UI can reuse an eligible unpaid link or request a distinct payment against refreshed state. Provider ambiguity blocks another equivalent request until reviewed. A new login clears cached data and the API checks current tenant and staff capability again before starting the provider call.

## Reminders

The owner controls activation, one to three reminders, and the interval in days. Reminders become eligible from the issued invoice due date. The sequence identity is unique per invoice. Recovery uses bounded candidates and atomic row claims. A pending or ambiguous send pauses later requests. Paid, obsolete and consent-revoked reminders have explicit outcomes. An invoice reminder is transactional and contains its reference and exact current outstanding balance. Consent requires a signed `START PAYMENT REMINDERS` message. `STOP PAYMENT REMINDERS` revokes it at authenticated receipt materialization. An older or same-second start cannot supersede a stop.

Free-form reminders require an active WhatsApp service window. Outside it the configured template must have the supported body and language and be approved as a utility template for the tenant's pinned WhatsApp Business Account and phone. The application verifies this using the tenant's Graph API credentials and refreshes stale checks for waiting reminders in bounded batches. Missing or unapproved templates leave a visible waiting reason, which expires after seven days. The provider's final decision still applies to sends. Live template activation and deliverability are outside local acceptance. [Meta message templates reference](https://developers.facebook.com/docs/graph-api/reference/whats-app-business-account/message_templates/)

The scheduler commits reminder intent and the G1 outbox before a queue attempt. The outbound worker checks the current balance, consent, route, channel and owner settings before claiming and again before provider submission. A balance change cancels the obsolete send. Rate limits use the G1 attempt budget. An ambiguous send remains in review and accepts only matching signed status evidence. The owner inspects status in the invoice, including waiting, dispatch, delivery, and review.

## Partial returns

An owner or manager can open a case from a fulfilled order. Staff case work requires current permissions and applicable assignment. A repeat custody request must match the actor, case, item quantities and recorded evidence. The order lock caps the quantities of all pending and approved cases against the originally purchased items. Approval rechecks the verifier and assignments, applies one unique stock movement per eligible tracked line, and records custody, stock, case history and customer notice in one transaction. Damaged and made-to-order lines can be recorded as review without increasing available inventory. The older full return path and item returns share the order lock and cannot restore the same goods.

The case shows an explicit refund review, exchange or replacement obligation where relevant. A refund disposition requires an actual non-voided, attributed outbound ledger entry for that tenant, customer and order. The system records that evidence separately from physical custody. A replacement or exchange requires the customer's signed acknowledgement after approval. A case with outstanding obligations stays open. The notice tells the customer that the shop received the items, and signed outbound status provides delivery evidence when available.

## API and authorization

| Operation | Route and authority |
| --- | --- |
| Create, issue, cancel or send a standalone invoice | `POST /commerce/invoices` and `POST /commerce/invoices/:id/decision`, owner only. |
| Inspect balances and request payment | `GET /commerce/invoices/:id` requires payment read, `POST /commerce/invoices/:id/checkout` requires payment creation and rechecks the current actor and identity inside the transaction. |
| Record a refund against an invoice | `POST /commerce/invoices/:id/adjustments`, owner only, with a replay key and verified remaining credit. |
| Configure and inspect reminders | `GET/PUT /commerce/reminders/policy` and `GET /commerce/invoices/:id/reminders`, owner only. |
| Open and record item custody | `POST /commerce/orders/:id/return-case` and `POST /commerce/cases/:id/returns`, authorized owner or staff as applicable. |
| Approve or resolve item custody and obligations | `POST /commerce/cases/:id/returns/:returnId/decision`, owner only. `POST /commerce/cases/:id/returns/:returnId/resolution`, current case and financial or signed customer evidence as applicable. |

## Recovery and migration

1. For an ambiguous checkout, inspect the existing initialization, request reference and receipt. Keep the invoice in review while the provider outcome is unknown. Use the G1 reconciliation record to resolve the original request.
2. For verified payment awaiting preparation, inspect the invoice balance, order and release evidence. Preparation and workflow evidence commit atomically. Resume the workflow scheduler against the same database. Replay can produce only one preparation task.
3. For a waiting reminder, check its stored reason, customer permission and approval status. Restart outbound recovery when queue state is lost. If the provider outcome is uncertain, retain the send and wait for signed evidence.
4. For a return, inspect the order item, case, custody evidence and stock movement. Resolve any recorded refund or exchange requirement through its own evidence. Inventory correction does not settle an obligation.
5. For a media admission HTTP 503, use `prismaCode`, `sqlState`, `eventCount` and `mediaCount` for diagnosis. The signer can retry exact events. Protect receipt identity and customer data by leaving original payloads out of the incident record.

Apply the three completion migrations with the app stopped to reconcile runtime/schema versions. Back up and verify the restored dataset before a change. Binary rollback supports the legacy workflows on the additive schema. Quiesce checkout and settlement for the newly allocated invoices, reminder producers, and all return writes while the earlier binary is active. Use order-scoped invoice reads during rollback because an older Prisma client expects a non-null order. Earlier binaries also have no item-level quantity fence before the full-return action. Preserve the new records and reintroduce the final binary to resume their recovery. Schema reversal would remove committed evidence and requires an explicit data disposition.
