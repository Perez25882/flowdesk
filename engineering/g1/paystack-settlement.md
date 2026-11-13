# G1-03 Paystack merchant settlement

## Acceptance and settlement

`POST /api/v1/webhooks/paystack` verifies the legacy `x-paystack-signature` HMAC over the original bytes. A signed `charge.success` with a valid FlowDesk merchant reference is accepted only after PostgreSQL commits a receipt or confirms an identical committed receipt. A storage error returns 503. Invalid signatures are rejected. Subscription callbacks use their existing route behavior, and unsupported merchant events leave the ledger untouched. [Paystack webhooks](https://paystack.com/docs/payments/webhooks/)

The inbox identifies exact deliveries by the SHA-256 digest of the signed bytes. Settlement identifies the financial transaction by the exact verified decimal transaction ID. Different bytes for the same transaction create separate receipts and can reference only one credited request. Callback transaction IDs are checked when present. No callback-supplied financial fields or tenant metadata authorize a credit.

The worker looks up the reference locally, verifies it through Paystack, and records normalized evidence under the current lease. It requires the exact reference, successful status, transaction ID, configured test/live mode, positive exact GHS amount in minor units, the pinned Paystack subaccount, and a usable verified payment time. Returned FlowDesk relationship metadata, when present, must agree with the local record. The subaccount cannot belong to a different business. The database transaction locks the receipt, customer, optional order, payment request and provider transaction identity. It revalidates the local relationship and request state before committing the attested ledger credit, order and customer totals, request linkage, unique settlement evidence, receipt completion, and pending notification together. A no-order request updates the customer only. [Paystack transaction verification](https://paystack.com/docs/api/transaction/#verify-transaction) · [G1-04 financial contract](payment-relationships.md)

| Condition | Disposition |
| --- | --- |
| Open request or an expired request with verified payment strictly before expiry | Settle once, subject to all checks. |
| Callback after the financial commit | A matching, active settlement completes the new receipt without another credit. |
| Historical paid request with one consistent linked gateway credit | Confirm the historical link with verified evidence. Preserve the ledger and suppress an additional receipt notification. |
| Partial, excess, late or cancelled payment | Review with a reason and evidence. Apply zero additional credit. |
| Reversed, conflicting, voided, or half-settled historical payment | Review. Existing payments and balance adjustments remain recorded. |
| Unproven transaction, currency, merchant, timestamp or relationship | Review. A tenant association comes from the committed request or initialization. An unknown reference has no tenant scope. |
| Pending provider status, timeout, transient write failure or initialization still in progress | Wait within the bounded retry budget. Expired claims are recoverable after restart. |

## State and recovery

Receipts move from `PENDING` or due `WAITING` to `PROCESSING`. A competing poller skips locked rows. Claims last 60 seconds and require a matching lease token to update. The worker claims at most ten receipts per pass, with at most six attempts per receipt. Provider and write retries back off from 30 seconds up to 15 minutes. Exhaustion and policy exceptions enter `REVIEW`. `SETTLED` includes financial commit evidence or a verified existing credit. A process crash between verification and commit leaves recoverable evidence and no partial credit. A crash after commit finds the financial write and completion together.

Hosted initialization commits an intent before contacting Paystack. Its state is `INITIALIZING`, `CREATED` after the request and activity commit, or `REVIEW` when the provider response or local commit is ambiguous. The worker also flags intents that have been left in progress for over one minute. An equivalent new checkout is held while an intent is unresolved. A callback for an unresolved intent can be verified and retained under the intent's tenant. It cannot allocate funds without a matching committed request. Provider calls and database transactions have separate commit boundaries.

The committed notification effect has its own bounded lease and retry budget of five. Redis downtime leaves the effect `PENDING` while settlement continues. After Redis returns, the worker hands off to a deterministic BullMQ job or records `SUPPRESSED` when customer receipts are disabled or the payment was voided. `HANDED_OFF` records queue acceptance. Actual WhatsApp delivery and recovery after job eviction remain G1-08 concerns. The combined API process still uses the existing Redis startup prerequisite.

### Tenant-scoped runbook

Use the commands with an authorized database connection and an explicit business ID. Each list is capped at 100 recent entries. `retry` only advances a waiting receipt's next attempt. It preserves attempt limits and scope. `drain` runs a bounded pass through the same verifier and financial checks used by the worker.

```powershell
pnpm --filter @flowdesk/api exec tsx scripts/reconcile-paystack.ts list <businessId>
pnpm --filter @flowdesk/api exec tsx scripts/reconcile-paystack.ts retry <businessId> <receiptId>
pnpm --filter @flowdesk/api exec tsx scripts/reconcile-paystack.ts drain <businessId>
```

For `REVIEW`, compare the recorded reference, verified transaction ID, amount, merchant, timestamp, initialization and original ledger rows against authorized provider evidence. Preserve both sources. Escalate allocation discrepancies and reversals for approved financial reconciliation. If an initialization may have succeeded, confirm whether the provider checkout or transaction can still settle before authorizing an intent disposition or a new checkout. `ABANDONED` is reserved for an explicitly authorized resolution after that confirmation. The CLI performs no review overrides, refund, transfer or manual credit. Unknown unassigned references require a separate authorized platform-level investigation. Manual entries still lack a request idempotency key.

## Threat model and migration

Signature checks protect receipt admission. Replay and concurrent event variants are controlled by PostgreSQL uniqueness and transaction locks. A guessed reference or substituted provider metadata cannot bind an event to another business or authorize a different order or customer. Provider HTTP and DB failures leave a retry or review trail. There is no assumption that a successful Paystack operation commits any local write.

Migration `20261111100000_durable_paystack_settlement` adds receipt, settlement and initialization tables without rewriting historical payments. It adds receipt state/time and tenant/reference lookup indexes, notification due indexes, a ledger reference index, and unique keys on delivery digest, provider transaction, request, payment and the originating receipt. G1-04 SQL-managed relationship constraints remain active. Retain normalized evidence and audit identifiers until an approved retention policy exists. The inbox persists no raw callback body, authorization data or provider secrets.

The migration is transactional. If a release rollback is required after deployment, preserve the new tables and receipts. Pause merchant callback processing before restoring any older handler that acknowledges through the legacy path, and reconcile the retained inbox and intents before resuming. Production migration lock duration, live callback delivery, hosted merchant verification shape and provider-side link disposition remain unverified.
