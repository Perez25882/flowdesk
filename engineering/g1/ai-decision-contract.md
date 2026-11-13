# G1-05 AI decisions and business commitments

## Authority and modes

The customer may request an action for their own conversation. Verified inbound identity comes from the message and its tenant/customer association. A model may interpret that request and propose an effect. It cannot grant authority, assert payment or delivery, or pass through arbitrary customer-facing prose. All modes use the same evidence checks. Raw model output, history, quotes, forwarded text, vision descriptions, business notes, catalogue prose and owner voice examples carry no permissions.

| Mode | Policy |
| --- | --- |
| `OFF` | The assistant does not call the model. Rule-engine-only legacy handling remains available for explicit orders and owned order-status lookups. |
| `DRAFT_ONLY` | Verified replies may be drafted. An explicit order may get a server-authored clarification. Order and appointment mutations require the ordinary dashboard workflow. |
| `GROUNDED_AUTO` | Verified customer replies, eligible pending orders and bookings may proceed automatically. |
| `AUTONOMOUS` | The same checks apply, with explicit owner consent and additional permission to initiate eligible checkout. |

All automated sends respect customer blocking, account state, the messaging window, plan allowance and the owner takeover rules. The model cannot choose the recipient or invoke a tool. Ordinary greetings, acknowledgments and catalogue discovery use server-authored text. A rejected or unavailable model turn may send a fixed holding line and flags the existing inbox for review. Custom intent templates and legacy order creation cannot run as a secondary path from an assistant refusal. No new owner interface is required.

## Supported commitments

| Operator | Typed effect and authority | Freshness, permissions and outcome |
| --- | --- | --- |
| Sales & Orders | `product_quote` and `product_stock` require a uniquely matched tenant product in the customer's request. The pricing ladder supplies the live promotion, quantity tier and optional configured floor. The customer must supply the quantity for a multi-unit quote. A pending order additionally requires explicit purchase language and deterministic agreement with the requested items and quantities. | Re-read the catalogue before reply. The order transaction locks current customer and catalogue records, verifies price and stock, and commits the pending order and inbound link together. Pending orders await owner confirmation and do not reserve inventory. Missing or ambiguous facts produce clarification or review. |
| Leads & Bookings | `booking_slots` displays current options for a requested tenant service. A booking requires the exact service and instant from computed availability plus an explicit customer reservation request. | The booking service rechecks current policy, service state, customer, schedule and capacity under locks. PostgreSQL rejects overlapping slots. Confirmation is rendered from the committed appointment. An unavailable slot or ambiguous request goes to review. |
| Payments & Invoices | `payment_balance` requires a reference belonging to the current tenant and customer, a billable order and its non-voided attested ledger. Checkout requires an explicit pay request or completed deterministic delivery capture and an eligible order balance. | The G1-04 relationship lock and G1-03 checkout initialization apply. Amount is rechecked against the locked ledger before checkout. The provider link is sent using the existing queue. No AI action attests, settles, refunds or transfers money, or issues an invoice. |
| Fulfillment & Operations | `order_status` uses the current customer's scoped order. `delivery_fee` uses an exact matching configured area and a verified fee. Deterministic delivery capture can record customer-provided contact/address data for the customer's order. | Rendering uses current saved settings. Delivery capture acknowledges details without promising coverage or delivery. Dispatch, proof, completion and fulfillment mutations remain with authorized users under G1-02. No automated ETA or delivery completion promise is supported. |
| Customer Care & Retention | `business_location` can use a validated saved map link or GhanaPost code. Routine greeting, thanks and clarifications use fixed text. Unknown or private record requests reach the inbox without model prose. | Approved drafts require `messages.send`, the exact current draft, fresh evidence and the tenant/customer relationship. Old or stale drafts can be discarded. A user may write their own message in the existing composer under normal messaging permissions. |

The supported grammar is intentionally narrow. Implicit purchases, ambiguous variants, unsupported cross-turn actions, unspecified appointment times, unconfigured delivery coverage, refund assurances, private contacts, policy exceptions and mixed proposals can require a person. Untrusted retrieved prose is never sent as a fact. The assistant reads same-customer conversation history, quotes and voice examples only; unassigned shop outbound posts may supply contextual data. Prompt fences supplement the output and service controls.

## Audit and recovery

`messages.aiPolicy` stores the policy version, mode, state, effect, safe reasons and evidence identifiers. New turns do not persist the full model envelope. Verified drafts retain the typed facts required for reevaluation. Existing historical decisions are preserved. `PROCESSING` is an atomic message claim and review marker. `REVIEW` records a refusal or dependency failure. `WAITING_CUSTOMER` records a saved clarification. `WAITING_HANDOFF` records a committed effect needing outbound recovery. `HANDED_OFF` records BullMQ acceptance. `APPROVED` and `REJECTED` record the reviewer. The existing inbox surfaces review work.

If a worker stops after claiming a turn, check the inbound policy record, `relatedOrderId`, appointment source identity, Paystack request and queue job as applicable. The existing retry guard and scoped domain effect identities prevent another mutation for the same inbound message. A stopped turn is flagged for review and is not replayed blindly. For an unclear handoff, review the existing order/appointment and outbound state before sending any human follow-up. Confirmed provider delivery and replay of evicted or ambiguous outbound jobs remain G1-08 work.

Migration `20261113100000_assistant_policy` adds the nullable policy record and a nullable unique appointment source key. Historical data is preserved and existing drafts cannot be approved as verified unless they have current policy evidence. The existing G1-01, G1-03 and G1-04 data contracts continue to apply.
