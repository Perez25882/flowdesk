# Flowdesk — Database Schema Reference
**Database:** PostgreSQL 15 | **ORM:** Prisma 5

---

## Schema Map

```
businesses          ← Root tenant. Everything belongs to a business.
    │
    ├── sessions            Auth sessions (one per device)
    ├── staff               Staff members with role-scoped access
    │     └── staff_activity     Immutable staff action audit log
    │
    ├── customers           Auto-created on first WhatsApp message
    │     ├── orders              Orders from customers
    │     │     ├── order_items        Line items (matched + unmatched)
    │     │     └── order_status_history  Immutable status change audit
    │     ├── payments            Payments from customers
    │     └── messages            All WhatsApp messages (in + out)
    │
    ├── products            Product catalog
    │     └── stock_movements     Immutable inventory change log
    │
    ├── intent_corrections  Owner corrections to intent classification
    └── broadcasts          (V2) Broadcast messages to segments
```

---

## Table Reference

---

### `businesses`
The root table. Every other record belongs to a business via `businessId`. The login identifier is `phone` — normalized to Ghana international format (233XXXXXXXXX).

| Column | Type | Notes |
|--------|------|-------|
| id | String (CUID) | Primary key |
| name | String | Business display name |
| ownerName | String | Owner's full name |
| phone | String UNIQUE | Login ID. Normalized: 233XXXXXXXXX |
| waPhoneNumberId | String? UNIQUE | Meta's phone number ID for the WABA |
| waAccessToken | String? | System user token — encrypted at rest, never returned in API responses |
| waWebhookVerified | Boolean | True after Meta verifies the webhook endpoint |
| plan | Enum BusinessPlan | STARTER / BUSINESS / GROWTH / ENTERPRISE / SUSPENDED |
| trialEndsAt | DateTime? | End of free trial |
| suspendedAt | DateTime? | When account was suspended |
| suspendReason | String? | "payment_failed" / "trial_expired" / "manual" |
| paystackCustomerId | String? UNIQUE | Paystack customer ID for billing |
| paystackSubCode | String? | Paystack subscription code for recurring charge |
| monthlyConvoCount | Int | WhatsApp conversations used this billing cycle |
| convoCountResetAt | DateTime? | When the monthly counter was last reset |
| monthlyOrderCount | Int | Orders created this billing cycle |
| orderCountResetAt | DateTime? | When the monthly order counter was last reset |
| replyTemplates | Json? | Map of templateKey → customText. null = use defaults |
| notifyOnNewOrder | Boolean | Send owner WhatsApp alert on new order |
| notifyOnLowStock | Boolean | Send owner WhatsApp alert on low stock |
| notifyOnPayment | Boolean | Send owner WhatsApp alert on payment confirmation |
| active | Boolean | False = deleted/deactivated |
| createdAt | DateTime | UTC |
| updatedAt | DateTime | UTC, auto-updated |
| deletedAt | DateTime? | Soft delete timestamp |

**Indexes:**
- `phone` — unique, login lookup
- `plan` — filter by plan for analytics
- `waPhoneNumberId` — unique, incoming webhook routing

---

### `sessions`
One record per active login session. Refresh tokens stored as SHA-256 hash — the raw token is never persisted.

| Column | Type | Notes |
|--------|------|-------|
| id | String (CUID) | Primary key |
| businessId | String FK | Parent business |
| staffId | String? FK | Null for owner sessions |
| refreshTokenHash | String UNIQUE | SHA-256(raw_refresh_token) |
| expiresAt | DateTime | 30 days from creation |
| userAgent | String? | Browser/device UA string |
| ipAddress | String? | Masked: first 3 octets only (192.168.1.xxx) |
| deviceName | String? | Human-readable, set by user |
| createdAt | DateTime | |
| lastUsedAt | DateTime | Updated on every refresh |

**Indexes:**
- `refreshTokenHash` — unique, token validation on every refresh
- `expiresAt` — cleanup job removes expired sessions nightly

---

### `customers`
Auto-created on first inbound WhatsApp message. No manual entry required.
`outstandingBalance` and `totalSpend` are denormalized for performance — updated on every payment verification and order status change.

| Column | Type | Notes |
|--------|------|-------|
| id | String (CUID) | Primary key |
| businessId | String FK | |
| waNumber | String | Normalized: 233XXXXXXXXX |
| name | String? | From WA contacts or manually added |
| outstandingBalance | Decimal(12,2) | Orders confirmed - verified payments |
| totalSpend | Decimal(12,2) | Lifetime verified payments |
| totalOrders | Int | Lifetime order count |
| blacklisted | Boolean | Flags messages, suppresses auto-replies |
| waNumberInvalid | Boolean | True when Meta returns "not on WhatsApp" error |
| vip | Boolean | Badge shown prominently on order cards |
| tags | String[] | Custom classification labels |
| lastInteractionAt | DateTime? | Updated on every inbound message |
| firstOrderAt | DateTime? | Set when first order is created |
| notes | String? | Private owner notes |
| createdAt | DateTime | |
| updatedAt | DateTime | |
| deletedAt | DateTime? | Soft delete |

**Unique constraint:** `(businessId, waNumber)` — no duplicate customers per business.

**Indexes:**
- `(businessId, waNumber)` — hot path: every inbound message does this lookup
- `(businessId, lastInteractionAt DESC)` — recent customers list
- `(businessId, outstandingBalance)` — outstanding balances view
- `(businessId, blacklisted)` — blacklist check on every inbound message

---

### `orders`
Created automatically from ORDER-intent messages or manually by owner.
`referenceNumber` (FD-XXXXX) is globally unique and generated via Redis INCR per business.

| Column | Type | Notes |
|--------|------|-------|
| id | String (CUID) | Primary key |
| businessId | String FK | |
| customerId | String FK | |
| referenceNumber | String UNIQUE | FD-00001 format. Global unique. |
| rawMessage | String | Original customer message verbatim. Never modified. |
| isManual | Boolean | True = created by owner for walk-in/phone order |
| status | Enum OrderStatus | PENDING / CONFIRMED / PROCESSING / FULFILLED / CANCELLED |
| totalAmount | Decimal(12,2) | Sum of matched order_items.subtotal |
| amountPaid | Decimal(12,2) | Sum of verified payments linked to this order |
| assignedStaffId | String? FK | Staff member handling this order |
| stockDeducted | Boolean | Prevents double stock deduction on retry |
| confirmedAt | DateTime? | When status → CONFIRMED |
| fulfilledAt | DateTime? | When status → FULFILLED |
| cancelledAt | DateTime? | When status → CANCELLED |
| cancelReason | String? | Required when cancelling |
| notes | String? | Owner private notes |
| createdAt | DateTime | |
| updatedAt | DateTime | |
| deletedAt | DateTime? | Soft delete |

**Status Transition Rules:**
```
PENDING    → CONFIRMED | CANCELLED
CONFIRMED  → PROCESSING | CANCELLED
PROCESSING → FULFILLED | CANCELLED
FULFILLED  → (terminal — no further transitions)
CANCELLED  → (terminal — no further transitions)
```

**Indexes:**
- `(businessId, status)` — kanban column queries
- `(businessId, createdAt DESC)` — recent orders list
- `(businessId, customerId)` — customer order history
- `(businessId, assignedStaffId)` — staff's work queue
- `referenceNumber` — status check lookups (customer sends "FD-00234?")
- `(businessId, status, createdAt DESC)` — combined dashboard query

---

### `order_items`
Line items belonging to an order. Matched items have `productId` and pricing. Unmatched items are description-only (order still created, no price calculated).

| Column | Type | Notes |
|--------|------|-------|
| id | String (CUID) | Primary key |
| orderId | String FK | Cascade delete with order |
| productId | String? FK | Null if not matched to catalog |
| description | String | Always stored — mirrors product name if matched |
| quantity | Decimal(10,3) | Supports fractions (0.5 kg, etc.) |
| unitPrice | Decimal(12,2) | 0 if unmatched |
| subtotal | Decimal(12,2) | quantity × unitPrice. 0 if unmatched |
| matched | Boolean | Was this matched to a catalog product? |
| matchConfidence | Float? | 0–1 fuzzy match similarity score |

**Indexes:**
- `orderId` — load order items (with order)
- `productId` — revenue by product analytics

---

### `order_status_history`
Append-only. Every status transition creates one record. Never updated or deleted.

| Column | Type | Notes |
|--------|------|-------|
| id | String (CUID) | Primary key |
| orderId | String FK | Cascade delete with order |
| fromStatus | Enum? | Null for initial PENDING creation |
| toStatus | Enum | The new status |
| changedBy | String? | staffId / 'owner' / 'system' / worker name |
| note | String? | Optional context |
| createdAt | DateTime | |

---

### `products`
The business's product catalog. Used for order item matching, pricing, and inventory tracking.

| Column | Type | Notes |
|--------|------|-------|
| id | String (CUID) | Primary key |
| businessId | String FK | |
| name | String | "Rice 50kg" |
| sku | String? | Internal code — optional |
| aliases | String[] | Alternate names for fuzzy matching: ["rice", "50kg rice", "big rice"] |
| unit | String | "bag", "carton", "piece", "kg", "litre", "sachet" |
| price | Decimal(12,2) | Selling price in GHS |
| stockQuantity | Decimal(10,3) | Current stock. Negative allowed. |
| reorderThreshold | Decimal(10,3) | Alert fires when stockQuantity ≤ this |
| active | Boolean | False = discontinued. Filtered from catalog, not deleted. |
| createdAt | DateTime | |
| updatedAt | DateTime | |
| deletedAt | DateTime? | Soft delete |

**Unique constraint:** `(businessId, sku)` — SKU unique per business (when set).

**Indexes:**
- `(businessId, active)` — catalog display (active products only)
- `(businessId, stockQuantity)` — low stock queries

---

### `stock_movements`
Immutable log of every inventory change. Enables full audit trail and stock history.

| Column | Type | Notes |
|--------|------|-------|
| id | String (CUID) | Primary key |
| businessId | String FK | |
| productId | String FK | |
| type | Enum StockMovementType | SALE / RESTOCK / ADJUSTMENT / RETURN |
| quantity | Decimal(10,3) | Negative for deductions (SALE), positive for additions |
| balanceAfter | Decimal(10,3) | Snapshot of stock after this movement |
| orderId | String? | Set for SALE and RETURN types |
| staffId | String? | Who made the adjustment |
| note | String? | Required for ADJUSTMENT type |
| createdAt | DateTime | |

**Indexes:**
- `(productId, createdAt DESC)` — stock history for a product
- `orderId` — find stock movements for an order

---

### `payments`
Every payment logged against a customer or order. Unverified payments (screenshots awaiting review) are stored with `verified = false`.

| Column | Type | Notes |
|--------|------|-------|
| id | String (CUID) | Primary key |
| businessId | String FK | |
| customerId | String FK | |
| orderId | String? FK | Optional — can log against customer balance directly |
| amount | Decimal(12,2) | Payment amount in GHS |
| method | Enum PaymentMethod | MOMO_MTN / MOMO_VODAFONE / MOMO_AIRTELTIGO / CASH / BANK_TRANSFER / OTHER |
| reference | String? | MoMo transaction ID, bank reference, etc. |
| screenshotUrl | String? | S3 URL of payment screenshot |
| screenshotKey | String? | S3 object key (for deletion) |
| verified | Boolean | False = awaiting review |
| verifiedBy | String? | staffId / 'owner' |
| verifiedAt | DateTime? | When verified |
| loggedById | String? | Who logged it: staffId / 'owner' / 'system' |
| notes | String? | |
| createdAt | DateTime | |
| updatedAt | DateTime | |

**Indexes:**
- `(businessId, customerId)` — customer payment history
- `(businessId, orderId)` — order payment status
- `(businessId, verified)` — screenshot review queue (verified = false)
- `(businessId, createdAt DESC)` — payment log

---

### `messages`
Every WhatsApp message passing through the system — inbound (customer → business) and outbound (auto-replies, receipts). The primary record for everything that touches the messaging layer.

| Column | Type | Notes |
|--------|------|-------|
| id | String (CUID) | Primary key |
| businessId | String FK | |
| customerId | String? FK | Null briefly on creation (customer upserted async) |
| waMessageId | String UNIQUE | Meta's message ID — deduplication key |
| direction | Enum MessageDirection | INBOUND / OUTBOUND |
| type | Enum MessageType | TEXT / IMAGE / AUDIO / VIDEO / DOCUMENT / STICKER / REACTION / etc. |
| body | String? | Text content. Null for non-text types. |
| mediaUrl | String? | S3 URL (stored before Meta's temp URL expires) |
| mediaKey | String? | S3 object key |
| mediaType | String? | MIME type (image/jpeg, audio/ogg, etc.) |
| reactionEmoji | String? | For REACTION type |
| reactedToWaId | String? | waMessageId of the reacted-to message |
| intent | Enum IntentType | UNCLASSIFIED until worker processes |
| intentConfidence | Float? | 0.0–1.0 |
| classifiedBy | Enum? | RULE_ENGINE / HAIKU / MANUAL |
| processed | Boolean | False = in queue or pending |
| processedAt | DateTime? | When worker completed processing |
| processingError | String? | Error after all retries exhausted |
| requiresReview | Boolean | Low confidence / complaint / unclassified |
| relatedOrderId | String? | Set after order created from this message |
| rawPayload | Json? | Full Meta webhook payload for debugging and replay |
| createdAt | DateTime | |

**Indexes:**
- `waMessageId` — unique, deduplication on every inbound message
- `(businessId, processed)` — worker pickup queue
- `(businessId, requiresReview)` — review queue for owner
- `(businessId, intent)` — intent analytics
- `(businessId, createdAt DESC)` — message history
- `(businessId, processed, createdAt DESC)` — unprocessed backlog monitoring

---

### `intent_corrections`
When owner corrects a misclassification, it's logged here. Used to detect patterns and improve the rule engine.

| Column | Type | Notes |
|--------|------|-------|
| id | String (CUID) | Primary key |
| businessId | String FK | |
| messageId | String | The message that was corrected |
| originalIntent | Enum IntentType | What the system classified it as |
| correctedIntent | Enum IntentType | What it actually was |
| originalSource | Enum? | Which classifier got it wrong |
| originalConfidence | Float? | How confident it (wrongly) was |
| correctedBy | String | staffId / 'owner' |
| createdAt | DateTime | |

**Indexes:**
- `(originalIntent, correctedIntent)` — pattern analysis: "GREETING misclassified as ORDER" patterns

---

### `staff`
Staff members with role-based dashboard access. Phone is their login identifier.

| Column | Type | Notes |
|--------|------|-------|
| id | String (CUID) | Primary key |
| businessId | String FK | |
| name | String | |
| phone | String | Normalized: 233XXXXXXXXX |
| role | Enum StaffRole | MANAGER / OPERATIONS / DELIVERY |
| active | Boolean | False = deactivated (cannot login) |
| passwordHash | String? | bcrypt cost 12. Null until invite accepted. |
| inviteToken | String? UNIQUE | Random 32-byte hex. Sent in WA invite link. |
| inviteExpiry | DateTime? | 48hr from invite creation |
| invitedAt | DateTime | |
| inviteAcceptedAt | DateTime? | When invite was completed |
| lastLoginAt | DateTime? | |
| createdAt | DateTime | |
| updatedAt | DateTime | |

**Unique constraint:** `(businessId, phone)` — one staff record per phone per business.

**Indexes:**
- `(businessId, active)` — active staff list
- `inviteToken` — unique, invite acceptance lookup

---

### `staff_activity`
Immutable log of every significant staff action. Append-only. Never updated.

| Column | Type | Notes |
|--------|------|-------|
| id | String (CUID) | Primary key |
| staffId | String FK | Cascade delete with staff record |
| action | String | 'order.confirmed', 'payment.logged', 'product.adjusted', etc. |
| resourceId | String? | ID of the record acted on |
| resourceType | String? | 'order', 'payment', 'product', 'customer' |
| note | String? | Human-readable description |
| createdAt | DateTime | |

**Indexes:**
- `(staffId, createdAt DESC)` — staff activity log in owner audit view
- `(resourceType, resourceId)` — "show all actions on order X"

---

### `broadcasts` (V2)
WhatsApp broadcast messages to customer segments. Business plan+. Schema defined now for architectural awareness — feature built in V2.

| Column | Type | Notes |
|--------|------|-------|
| id | String (CUID) | Primary key |
| businessId | String FK | |
| templateName | String | Meta-approved template |
| message | String | Rendered message content for display |
| variables | Json? | Template variable values used |
| targetTags | String[] | Send to customers with any of these tags |
| targetAll | Boolean | Ignore tags, send to all customers |
| recipientCount | Int | How many will receive it |
| sentCount | Int | How many successfully sent |
| failedCount | Int | How many failed |
| status | String | draft / scheduled / sending / completed / failed |
| scheduledAt | DateTime? | When to send (null = send immediately) |
| startedAt | DateTime? | |
| completedAt | DateTime? | |
| createdBy | String | staffId / 'owner' |
| createdAt | DateTime | |
| updatedAt | DateTime | |

---

## Design Decisions

### Why Decimal for Money, Never Float
Float arithmetic is imprecise. `0.1 + 0.2 = 0.30000000000000004` in floating point. All monetary values use `Decimal(12, 2)` — up to GHS 9,999,999,999.99 with exact cent precision. Arithmetic done in PostgreSQL or with a Decimal library in JS, never native floats.

### Why CUID Over UUID
CUIDs are shorter, URL-safe, and roughly time-sortable. No performance difference at our scale. Better DX than UUID v4 for logging and debugging.

### Why Soft Deletes
Business data is never truly deleted in MVP. If a business owner accidentally deletes a customer or product, it can be recovered. Regulatory considerations in financial record-keeping. Hard deletes happen only after 30 days of account cancellation (automated cleanup job).

### Why Denormalize Customer Balances
`outstandingBalance` and `totalSpend` could be calculated by joining orders and payments. But the customer list is loaded constantly (search, balance view, inbound message lookup). Calculating it with a JOIN on every customer load at 10,000 customers would be slow. Trade-off: slightly more complex update logic (updated on payment verification and order status change) for much faster reads.

### Why `rawPayload` on Messages
Meta webhook payloads change. If there's a parsing bug or a new field added, the raw payload lets us replay messages and reprocess them correctly without data loss. It's nullable to save space for outbound messages that have no payload.

### Why `stockDeducted` on Orders
Workers retry on failure. If the order creation worker succeeds on creating the order but crashes before marking the job complete, BullMQ retries it. Without `stockDeducted`, stock would be deducted twice. The flag makes stock deduction idempotent.

---

## Migration Strategy

1. Every schema change is a new migration file — never edit an existing migration
2. Migrations run before deployment: `prisma migrate deploy`
3. All migrations must be backward-compatible with the running application
   (add columns as nullable, add defaults, never drop columns without a deprecation period)
4. Breaking migrations (rename column, change type): blue-green deployment required
5. Index creation uses `CREATE INDEX CONCURRENTLY` for zero-downtime on large tables
   (Prisma handles this in production migrations)
