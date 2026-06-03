# Flowdesk — Comprehensive System Architecture
**Version:** 2.0 | **Classification:** Internal Engineering Reference

---

# PART 1: ARCHITECTURAL OVERVIEW

## 1.1 Design Philosophy

Three non-negotiable principles drive every decision in this architecture:

**1. Zero Message Loss**
A WhatsApp message is stored to the database before any processing begins. If every downstream system fails simultaneously — the intent classifier, the order creator, the auto-reply sender — the message still exists in the database. It can be replayed. Nothing is lost.

**2. Async Everything After Acknowledge**
The webhook receiver acknowledges Meta in under 500ms and does exactly two things: validates the signature, stores the raw payload. Every other operation — classification, order creation, customer lookup, sending replies — happens in background workers. The HTTP response and the business logic are completely decoupled.

**3. Explicit Over Implicit**
Every failure mode is named, handled, and logged. There are no silent catches. There are no optimistic assumptions. Every external dependency is treated as unreliable.

---

## 1.2 System Topology

```
╔══════════════════════════════════════════════════════════════════════════════╗
║                         EXTERNAL LAYER                                       ║
╠══════════════════════════════════════════════════════════════════════════════╣
║                                                                              ║
║   WhatsApp User          Meta Cloud API          Business Owner Browser      ║
║   (Customer)             (Webhook Sender)         (Dashboard)                ║
║        │                      │                        │                     ║
║        └──── sends msg ───────┤                        │                     ║
║                               │ POST /webhook          │ GET /api/*          ║
╚═══════════════════════════════╪════════════════════════╪═════════════════════╝
                                │                        │
╔═══════════════════════════════╪════════════════════════╪═════════════════════╗
║                     CLOUDFLARE EDGE LAYER              │                     ║
╠═══════════════════════════════╪════════════════════════╪═════════════════════╣
║   DDoS Protection             │                        │                     ║
║   TLS Termination             │                        │                     ║
║   Rate Limiting (L7)          │                        │                     ║
║   Bot Protection              │                        │                     ║
╚═══════════════════════════════╪════════════════════════╪═════════════════════╝
                                │                        │
╔═══════════════════════════════╪════════════════════════╪═════════════════════╗
║                    APPLICATION LAYER (EC2 / ECS)       │                     ║
╠═══════════════════════════════╪════════════════════════╪═════════════════════╣
║                               ▼                        ▼                     ║
║                    ┌─────────────────────────────────────────┐               ║
║                    │         Fastify API Server              │               ║
║                    │                                         │               ║
║                    │  /webhook  → Webhook Module             │               ║
║                    │  /api/v1/* → Feature Modules            │               ║
║                    │  /sse/*    → SSE Manager                │               ║
║                    │  /health   → Health Check               │               ║
║                    └──────────────────┬──────────────────────┘               ║
║                                       │                                      ║
║                    ┌──────────────────▼──────────────────────┐               ║
║                    │         BullMQ Workers                  │               ║
║                    │                                         │               ║
║                    │  MessageProcessor                       │               ║
║                    │  IntentClassifier                       │               ║
║                    │  OrderCreator                           │               ║
║                    │  AutoReply                              │               ║
║                    │  InventoryCheck                         │               ║
║                    │  FailedJobAuditor                       │               ║
║                    └─────────────────────────────────────────┘               ║
╚═════════════════════════════════════════════════════════════════════════════╝
                                │
╔═══════════════════════════════▼═════════════════════════════════════════════╗
║                         DATA LAYER                                           ║
╠══════════════════════════════════════════════════════════════════════════════╣
║                                                                              ║
║   ┌─────────────────┐    ┌─────────────────┐    ┌──────────────────────┐    ║
║   │  PostgreSQL 15  │    │    Redis 7       │    │     AWS S3           │    ║
║   │                 │    │                 │    │   (af-south-1)       │    ║
║   │  Primary store  │    │  - BullMQ queues│    │                      │    ║
║   │  All business   │    │  - Cache layer  │    │  MoMo screenshots    │    ║
║   │  data           │    │  - SSE pub/sub  │    │  Media files         │    ║
║   │                 │    │  - Rate limits  │    │  Exports             │    ║
║   │                 │    │  - Sessions     │    │                      │    ║
║   └─────────────────┘    └─────────────────┘    └──────────────────────┘    ║
╚══════════════════════════════════════════════════════════════════════════════╝
                                │
╔═══════════════════════════════▼═════════════════════════════════════════════╗
║                      EXTERNAL SERVICES                                       ║
╠══════════════════════════════════════════════════════════════════════════════╣
║                                                                              ║
║   Meta Cloud API    Anthropic Haiku    Paystack    Resend    Sentry          ║
║   (send messages)   (intent fallback)  (billing)  (email)  (errors)         ║
╚══════════════════════════════════════════════════════════════════════════════╝
```

---

# PART 2: COMPLETE MESSAGE FLOW

## 2.1 Inbound Message — Full Timeline

```
T+0ms    ── Customer taps send on WhatsApp
T+50ms   ── Meta Cloud API receives message
T+80ms   ── Meta constructs webhook payload, signs with HMAC-SHA256
T+150ms  ── Cloudflare receives POST /webhook
             - TLS terminated
             - Rate limit check: max 500 req/min from Meta IP ranges
             - Request forwarded to Fastify
T+170ms  ── Fastify webhook receiver executes
             Step 1: Read raw body as Buffer (BEFORE JSON parsing)
             Step 2: Validate HMAC-SHA256 signature
                     expected = HMAC(body_buffer, META_APP_SECRET)
                     crypto.timingSafeEqual(expected, received_header)
                     Invalid → 401, log IP + timestamp, STOP
             Step 3: Parse JSON payload
             Step 4: Extract message entries from nested structure
             Step 5: For each entry — idempotency check (waMessageId in Redis)
                     Already seen → skip (Meta retries failed webhooks)
             Step 6: Store raw message to DB
                     INSERT INTO messages (waMessageId, businessId, direction=INBOUND,
                       type, rawPayload, processed=false, createdAt=NOW())
             Step 7: Push job to BullMQ messages queue
             Step 8: Cache waMessageId in Redis (TTL: 24h) for dedup
T+180ms  ── Fastify returns HTTP 200 to Meta
             Meta considers delivery successful
             (Meta will retry up to 3 times over 24hrs if no 200)
T+200ms  ── Message Processor Worker picks up job from queue
T+220ms  ── Parse webhook payload into structured fields
             Extract: waMessageId, from (sender number), body, type, timestamp
             Normalize: phone number → Ghana international format (233XXXXXXXXX)
             Determine: MessageType (TEXT | IMAGE | AUDIO | VIDEO | DOCUMENT | OTHER)
T+250ms  ── Customer upsert
             UPSERT customers WHERE businessId = ? AND waNumber = ?
             If new: create with name from WA contacts array (if present)
             If existing: update lastInteractionAt
T+280ms  ── Update message record
             SET customerId = ?, type = ?, body = ?, parsed = true
T+300ms  ── Route by message type
             TEXT    → push to intent queue
             IMAGE   → push to screenshot-check queue
             AUDIO   → flag requiresReview=true, push to notification (owner alert)
             OTHER   → log only
T+400ms  ── Intent Classifier Worker picks up job (TEXT path)
T+420ms  ── Stage 1: Rule Engine
             Normalize text (lowercase, trim, collapse whitespace)
             Match against all intent pattern sets
             Compute weighted confidence score
             Check ambiguity (two intents within 0.1 → apply penalty)
             Result: { intent, confidence, matchedPatterns }
T+430ms  ── Confidence check
             >= 0.75 → proceed with rule engine result
             < 0.75  → Stage 2: Haiku
T+430ms  ── (If Haiku needed) Check Redis cache first
             Key: sha256(normalized_text).slice(0,16)
             Cache hit → use cached result, skip API call
             Cache miss → call Haiku API (3s timeout)
T+600ms  ── Update message record with classification
             SET intent = ?, intentConfidence = ?, classifiedBy = ?, processed = true
T+620ms  ── Route by intent
             ORDER        → push to orders queue
             PAYMENT      → push to payment-flag queue
             STATUS_CHECK → push to status-lookup queue
             INQUIRY      → set requiresReview=true (owner handles)
             COMPLAINT    → set requiresReview=true (owner handles)
             GREETING     → push to auto-reply queue (courtesy reply if configured)
             UNCLASSIFIED → set requiresReview=true
T+800ms  ── Order Creator Worker picks up job (ORDER path)
T+820ms  ── Generate reference number
             INCR order:counter:{businessId} in Redis → atomic counter
             Format: FD-{counter padded to 5 digits}
             Redis fail → timestamp fallback (FD-{base36-timestamp})
T+850ms  ── Extract items from raw message text
             Parse quantities: "3", "three", "x3", "3bags" → 3
             Extract product names (everything that isn't a quantity/connector word)
             Best-effort — failures logged, order still created
T+900ms  ── Fuzzy match items against product catalog
             Load active products for businessId from Redis cache
             (Cache miss: load from DB, cache for 5min)
             Levenshtein similarity against name + aliases[]
             Threshold: 0.75 similarity → matched
             Below threshold → description-only item (no product link, no price)
T+950ms  ── DB Transaction: create order + items
             BEGIN TRANSACTION
               INSERT orders (businessId, customerId, referenceNumber,
                 rawMessage, status=PENDING, totalAmount, ...)
               INSERT order_items (orderId, productId?, description,
                 quantity, unitPrice, subtotal, matched)
               INSERT order_status_history (orderId, toStatus=PENDING,
                 changedBy='system')
             COMMIT
             Rollback on any error → log and rethrow
T+1000ms ── Push auto-reply job to notification queue
T+1010ms ── Broadcast SSE event: order.created
             { type: 'order.created', data: { orderId, referenceNumber,
               customerName, itemCount, totalAmount } }
T+1100ms ── Auto-Reply Worker picks up job
T+1120ms ── Select template
             Check customer.lastInteractionAt
             If within 24hr window → free-form text reply
             If outside window → use approved Meta template
T+1140ms ── Fill template variables
             {name} → customer.name or first name from WA profile
             {ref} → referenceNumber (FD-00234)
             {business} → business.name
T+1160ms ── Call Meta Cloud API
             POST https://graph.facebook.com/v20.0/{phoneNumberId}/messages
             Authorization: Bearer {META_ACCESS_TOKEN}
             Timeout: 10s
             Retry: 2 attempts on 5xx or timeout
T+1200ms ── Store outbound message to DB
             direction=OUTBOUND, type=TEXT, body=template_filled
T+1220ms ── Customer receives WhatsApp confirmation
             "Hi Kwame! We've received your order (Ref: FD-00234).
              We'll confirm shortly. — Ama's Store"
```

**Total time from customer send to confirmation received: ~1.2 seconds**

---

## 2.2 Owner Confirms Order — Full Timeline

```
T+0ms    ── Owner taps "Confirm" on dashboard OrderCard
T+30ms   ── PATCH /api/v1/orders/{id}/status { status: "CONFIRMED" }
             Authorization: Bearer {access_token}
T+40ms   ── Auth middleware
             Verify JWT signature
             Check expiry
             Extract { businessId, staffId, role } from payload
             Invalid/expired → 401 (frontend redirects to login)
T+50ms   ── Business context middleware
             Inject businessId into request context
             Every downstream call uses this — never from request body
T+60ms   ── Role check
             Transition PENDING→CONFIRMED requires: MANAGER or OPERATIONS or owner
             DELIVERY role → 403
T+70ms   ── Input validation (Zod schema)
             status must be a valid OrderStatus enum value
             note is optional string max 500 chars
T+80ms   ── Order service: confirmOrder()
T+90ms   ── Repository: findOrderById(id, businessId)
             If not found or businessId mismatch → NotFoundError
             businessId check is in the WHERE clause, not application logic
T+100ms  ── Validate state transition
             Current status must be PENDING to move to CONFIRMED
             Invalid transition → ValidationError (cannot confirm a fulfilled order)
T+110ms  ── DB Transaction
             BEGIN
               UPDATE orders SET status=CONFIRMED, updatedAt=NOW()
               INSERT order_status_history (orderId, fromStatus=PENDING,
                 toStatus=CONFIRMED, changedBy={staffId or 'owner'}, createdAt=NOW())
             COMMIT
T+130ms  ── Push inventory deduction job to inventory queue
             (Async — stock update doesn't block the response)
T+140ms  ── Push auto-reply job
             Customer notification: "Your order FD-00234 is confirmed
             and being prepared."
T+150ms  ── Broadcast SSE event: order.updated
             { type: 'order.updated', data: { orderId, newStatus: 'CONFIRMED',
               referenceNumber } }
T+160ms  ── Return HTTP 200 to dashboard
             { success: true, data: { order } }
T+170ms  ── Dashboard receives SSE event (independent of HTTP response)
             TanStack Query cache invalidated for orders
             OrderCard moves from PENDING column to CONFIRMED column
             No page refresh
T+200ms  ── Inventory Worker picks up job
             For each matched item in the order:
               UPDATE products SET stockQuantity = stockQuantity - quantity
               WHERE id = productId AND businessId = businessId
               RETURNING stockQuantity, reorderThreshold
             If stockQuantity <= reorderThreshold:
               Push stock-alert job to notification queue
T+400ms  ── Customer receives WhatsApp confirmation
T+450ms  ── (If stock alert) Owner receives WhatsApp stock alert
             "⚠️ Stock Alert: Rice (50kg) is running low.
              Current stock: 8 bags. Reorder threshold: 10 bags."
```

---

# PART 3: QUEUE ARCHITECTURE

## 3.1 Queue Registry

```
Queue: messages
  Purpose:   Process raw incoming webhook payloads
  Priority:  Critical
  Workers:   2 concurrent (scalable to 10)
  Attempts:  3
  Backoff:   Exponential (1s, 2s, 4s)
  Job data:  { messageId, businessId }

Queue: intent
  Purpose:   Classify message intent
  Priority:  Critical
  Workers:   3 concurrent
  Attempts:  3
  Backoff:   Exponential (500ms, 1s, 2s)
  Job data:  { messageId, businessId, text }

Queue: orders
  Purpose:   Create orders from classified messages
  Priority:  High
  Workers:   2 concurrent
  Attempts:  3
  Backoff:   Exponential (1s, 2s, 4s)
  Job data:  { messageId, businessId, customerId }

Queue: notifications
  Purpose:   Send WhatsApp messages outbound
  Priority:  High
  Workers:   4 concurrent (rate: 40 messages/sec ← below Meta's 80/sec limit)
  Attempts:  3
  Backoff:   Exponential (2s, 4s, 8s)
  Job data:  { businessId, waNumber, templateKey, variables }

Queue: screenshots
  Purpose:   Detect and flag MoMo payment screenshots
  Priority:  Medium
  Workers:   2 concurrent
  Attempts:  2
  Backoff:   Fixed (3s)
  Job data:  { messageId, businessId, mediaUrl }

Queue: inventory
  Purpose:   Deduct stock, check thresholds, trigger alerts
  Priority:  Medium
  Workers:   2 concurrent
  Attempts:  3
  Backoff:   Exponential (500ms, 1s, 2s)
  Job data:  { orderId, businessId }

Queue: status-lookup
  Purpose:   Look up order status for customer STATUS_CHECK messages
  Priority:  Medium
  Workers:   2 concurrent
  Attempts:  2
  Backoff:   Fixed (1s)
  Job data:  { messageId, businessId, customerId, text }

Queue: reports
  Purpose:   Generate async reports (CSV exports, analytics)
  Priority:  Low
  Workers:   1 concurrent
  Attempts:  2
  Backoff:   Fixed (5s)
  Job data:  { businessId, reportType, params, callbackEmail }

Queue: audit
  Purpose:   Process failed jobs from all other queues, alert team
  Priority:  Low
  Workers:   1 concurrent
  Runs:      Every 30 minutes (scheduled)
  Job data:  { queueName, failedJobIds[] }
```

## 3.2 Dead Letter Handling

Every queue has a failure listener. Jobs that exhaust all retries:

```
1. Job marked FAILED in Redis (retained for 500 jobs per queue)
2. Failure logged to Pino with full job data and error stack
3. Sentry event created with context
4. If queue is messages, orders, or notifications → immediate alert to ops
5. Daily audit job scans all failed jobs and emails summary
6. Failed jobs can be manually retried via Bull Board admin UI
```

---

# PART 4: DATABASE ARCHITECTURE

## 4.1 Multi-Tenancy Implementation

Every table with business data has `businessId`. Every repository function includes `businessId` in its WHERE clause. This is enforced at the data layer, not the application layer.

```sql
-- Example: NEVER this
SELECT * FROM orders WHERE id = $1;

-- ALWAYS this
SELECT * FROM orders WHERE id = $1 AND business_id = $2 AND deleted_at IS NULL;
```

A Prisma middleware enforces this:

```typescript
// Prisma middleware that throws if businessId is missing on multi-tenant models
prisma.$use(async (params, next) => {
  const multiTenantModels = ['Order','Customer','Product','Payment','Message','Staff'];
  const writeOps = ['create','update','updateMany','upsert'];

  if (multiTenantModels.includes(params.model ?? '') && writeOps.includes(params.action)) {
    const hasBusinessId =
      params.args?.data?.businessId ||
      params.args?.where?.businessId;

    if (!hasBusinessId) {
      throw new Error(`[SECURITY] ${params.model}.${params.action} called without businessId`);
    }
  }
  return next(params);
});
```

## 4.2 Soft Delete Implementation

Soft deletes are enforced via Prisma middleware that automatically appends `deletedAt IS NULL` to all find operations on soft-deletable models:

```typescript
const softDeleteModels = ['Order','Customer','Product','Business','Staff'];

prisma.$use(async (params, next) => {
  if (softDeleteModels.includes(params.model ?? '')) {
    if (params.action === 'findMany' || params.action === 'findFirst') {
      params.args.where = { ...params.args.where, deletedAt: null };
    }
    if (params.action === 'delete') {
      params.action = 'update';
      params.args.data = { deletedAt: new Date() };
    }
  }
  return next(params);
});
```

## 4.3 Index Strategy

```sql
-- businesses
CREATE UNIQUE INDEX ON businesses(phone) WHERE deleted_at IS NULL;

-- customers
CREATE UNIQUE INDEX ON customers(business_id, wa_number) WHERE deleted_at IS NULL;
CREATE INDEX ON customers(business_id, last_interaction_at DESC);
CREATE INDEX ON customers(business_id, outstanding_balance) WHERE outstanding_balance > 0;

-- orders
CREATE INDEX ON orders(business_id, status) WHERE deleted_at IS NULL;
CREATE INDEX ON orders(business_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX ON orders(business_id, customer_id) WHERE deleted_at IS NULL;
CREATE INDEX ON orders(reference_number); -- Unique, for status check lookups
CREATE INDEX ON orders(assigned_staff_id) WHERE assigned_staff_id IS NOT NULL;

-- messages
CREATE UNIQUE INDEX ON messages(wa_message_id); -- Deduplication
CREATE INDEX ON messages(business_id, processed) WHERE processed = false;
CREATE INDEX ON messages(business_id, requires_review) WHERE requires_review = true;
CREATE INDEX ON messages(business_id, created_at DESC);

-- products
CREATE INDEX ON products(business_id, active) WHERE deleted_at IS NULL;
CREATE INDEX ON products(business_id, stock_quantity) WHERE stock_quantity <= reorder_threshold;

-- payments
CREATE INDEX ON payments(business_id, verified) WHERE verified = false;
CREATE INDEX ON payments(business_id, created_at DESC);
CREATE INDEX ON payments(customer_id, created_at DESC);
```

## 4.4 Connection Pool Configuration

```
PostgreSQL connection pool (via Prisma):
  min connections: 2
  max connections: 10 per app instance
  connection timeout: 5000ms
  idle timeout: 30s

Redis connections:
  main client: 1 persistent connection
  subscriber client: 1 persistent connection (BullMQ dedicated)
  max retry attempts: 10 (exponential backoff)

At 4 app instances (Phase 2 ECS):
  Total DB connections: 4 × 10 = 40 (well within PG default limit of 100)
```

---

# PART 5: AUTHENTICATION ARCHITECTURE

## 5.1 Token Flow

```
REGISTRATION / FIRST LOGIN:
  1. POST /api/v1/auth/request-otp { phone }
     - Normalize phone number
     - Generate 6-digit OTP
     - Store in Redis: key=otp:{phone}, value={otp,attempts:0}, TTL=600s (10min)
     - Send OTP via WhatsApp template message
     - Return: { message: "OTP sent" } (same response whether phone exists or not)

  2. POST /api/v1/auth/verify-otp { phone, otp, name? }
     - Get OTP from Redis (not found → 401)
     - Increment attempt counter (>5 attempts → invalidate OTP, 429)
     - Compare OTP (timing-safe) (mismatch → 401)
     - Delete OTP from Redis (single-use)
     - Create or update business record
     - Create session record (refresh token stored hashed)
     - Return: { accessToken, refreshToken, business }

TOKEN REFRESH:
  POST /api/v1/auth/refresh { refreshToken }
  - Hash the refresh token
  - Find session WHERE refreshToken = hash AND expiresAt > NOW()
  - Not found → 401 (expired or already rotated)
  - Delete old session
  - Create new session with new refresh token
  - Issue new access token
  - Return: { accessToken, refreshToken }

LOGOUT:
  POST /api/v1/auth/logout
  Authorization: Bearer {accessToken}
  - Extract session from refresh token (sent in body)
  - Delete session record
  - Access token cannot be invalidated (stateless) but expires in 15min
  - Return: 204

LOGOUT ALL DEVICES:
  POST /api/v1/auth/logout-all
  Authorization: Bearer {accessToken}
  - DELETE FROM sessions WHERE businessId = ?
  - All existing tokens invalidated
```

## 5.2 JWT Structure

```typescript
// Access token payload
interface AccessTokenPayload {
  sub: string;        // businessId
  staffId?: string;   // set for staff members, undefined for owner
  role: 'OWNER' | 'MANAGER' | 'OPERATIONS' | 'DELIVERY';
  plan: BusinessPlan;
  iat: number;
  exp: number;        // iat + 900 (15 minutes)
}

// Refresh token: 32-byte random hex string, stored hashed (SHA256) in DB
// Never store the raw refresh token in the database
```

## 5.3 Staff Authentication Flow

```
1. Owner creates staff: POST /api/v1/staff { name, phone, role }
   - Creates staff record with status=PENDING
   - Generates invite token (32-byte random, expires 48hr)
   - Sends WhatsApp message with link: flowdesk.app/invite/{token}

2. Staff clicks link → web app loads:
   GET /api/v1/staff/invite/{token}
   - Validate token exists and not expired
   - Return: { staffName, businessName } (not the full staff record)

3. Staff sets password:
   POST /api/v1/staff/invite/{token}/accept { password }
   - Validate token again
   - Hash password (bcrypt, cost 12)
   - Set staff.passwordHash, clear inviteToken, set status=ACTIVE
   - Issue access + refresh tokens
   - Return: { accessToken, refreshToken }

4. Subsequent staff logins:
   POST /api/v1/auth/staff-login { phone, password }
   - Find staff by phone within the business
   - bcrypt.compare(password, passwordHash)
   - Issue tokens with staffId and role in payload
```

---

# PART 6: SSE REAL-TIME ARCHITECTURE

## 6.1 Connection Management

```typescript
// SSEManager is a singleton (module-level) on each app instance
// In multi-instance deployment: Redis pub/sub bridges instances

class SSEManager {
  // businessId → Set of active connections
  private connections = new Map<string, Set<SSEConnection>>();

  // Total connection count (for monitoring)
  private totalConnections = 0;

  // Max connections per business (prevents abuse)
  private MAX_CONNECTIONS_PER_BUSINESS = 10;
}
```

## 6.2 Multi-Instance SSE (Phase 2)

When multiple app instances run (ECS), an SSE event emitted on Instance A must reach browsers connected to Instance B. Solution: Redis pub/sub.

```
Event occurs on Instance A:
  1. Broadcast to local connections (Map lookup)
  2. Publish to Redis channel: sse:{businessId}
     PUBLISH sse:biz_xyz123 '{"type":"order.created","data":{...}}'

Instance B (subscribed to all sse:* channels):
  1. Receive published message
  2. Broadcast to local connections for that businessId
  3. All connected browsers receive the event regardless of which
     instance their SSE connection is on
```

## 6.3 Client Reconnection Protocol

```typescript
// Frontend SSE hook with exponential backoff reconnection
const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000];

class SSEClient {
  private source: EventSource | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  connect(token: string) {
    this.source = new EventSource(`/sse/connect?token=${token}`);

    this.source.onopen = () => {
      this.reconnectAttempt = 0; // Reset on successful connection
      // Invalidate all TanStack Query caches — catch up on missed events
      queryClient.invalidateQueries();
    };

    this.source.onerror = () => {
      this.source?.close();
      const delay = RECONNECT_DELAYS[
        Math.min(this.reconnectAttempt, RECONNECT_DELAYS.length - 1)
      ] ?? 30000;
      this.reconnectAttempt++;
      this.reconnectTimer = setTimeout(() => this.connect(token), delay);
    };
  }
}
```

## 6.4 SSE Event Catalog

```typescript
type SSEEvent =
  | { type: 'order.created';  data: { orderId: string; referenceNumber: string; customerName: string; itemSummary: string; totalAmount: number; createdAt: string } }
  | { type: 'order.updated';  data: { orderId: string; referenceNumber: string; newStatus: OrderStatus; changedBy: string } }
  | { type: 'order.assigned'; data: { orderId: string; staffId: string; staffName: string } }
  | { type: 'message.review'; data: { messageId: string; customerName: string; preview: string } }
  | { type: 'payment.flagged'; data: { messageId: string; customerId: string; customerName: string } }
  | { type: 'stock.alert';    data: { productId: string; productName: string; currentQty: number; threshold: number } }
  | { type: 'heartbeat';      data: { timestamp: string } }
```

---

# PART 7: INTENT CLASSIFICATION ARCHITECTURE

## 7.1 Two-Stage Pipeline

```
Stage 1: Rule Engine
  Input:  raw message text
  Output: { intent, confidence 0–1, matchedPatterns[] }
  Time:   < 50ms
  Cost:   $0

  If confidence >= threshold (default 0.75):
    → Use this result. Source = RULE_ENGINE.

  If confidence < threshold:
    → Stage 2.

Stage 2: Claude Haiku
  Input:  normalized text (max 500 chars)
  Output: { intent, confidence }
  Time:   < 3000ms (timeout)
  Cost:   ~$0.001 per call

  Before API call:
    → Check Redis cache (key: sha256(text), TTL: 24h)
    → Cache hit: use cached result. Zero API call.

  On API call:
    → AbortController at 3000ms
    → Parse structured JSON response
    → Cache result in Redis

  On failure (timeout, API error, parse error):
    → Log with full context
    → Return { intent: UNCLASSIFIED, confidence: 0 }
    → Mark message requiresReview = true
    → NEVER crash the worker
```

## 7.2 Confidence Score Calculation

```
Base score per matched pattern: pattern.weight (0.1 – 0.7)
Multiple patterns in same intent: scores compound (capped at 1.0)
Quantity indicators alone: not an ORDER (low weight, 0.3)
Order keyword + quantity: compound → high confidence

Ambiguity penalty:
  Top intent score:    0.65
  Second intent score: 0.60
  Gap: 0.05 (< 0.1 threshold)
  Penalty applied: -0.15
  Final confidence: 0.65 - 0.15 = 0.50 → escalates to Haiku

Minimum confidence to take action: 0.75
Below 0.75: message marked requiresReview, owner handles manually
```

## 7.3 Correction Learning Loop

```
Owner corrects misclassification from dashboard:
  PATCH /api/v1/messages/{id}/intent { intent: 'ORDER' }

System:
  1. Update message: intent=ORDER, classifiedBy=MANUAL
  2. Log correction event with original intent + corrected intent
  3. Store in corrections table: { text, originalIntent, correctedIntent, timestamp }

Weekly automated review (future V2):
  - Analyze correction patterns
  - If a specific pattern type is frequently corrected:
    → Generate new rule pattern (logged for developer review)
    → Developer reviews and merges into rule engine
```

---

# PART 8: WHATSAPP INTEGRATION ARCHITECTURE

## 8.1 Conversation Window Manager

```typescript
// 24-hour window check before every outbound message
async function getMessageStrategy(
  customer: Customer,
  messageType: 'transactional' | 'marketing'
): Promise<'freeform' | 'template'> {
  const windowMs = 24 * 60 * 60 * 1000;
  const lastInteraction = customer.lastInteractionAt;

  if (!lastInteraction) return 'template'; // Never messaged us

  const withinWindow = Date.now() - lastInteraction.getTime() < windowMs;

  if (withinWindow && messageType === 'transactional') return 'freeform';
  return 'template'; // Always use template outside window
}
```

## 8.2 Template Registry

```typescript
// All approved Meta templates registered here
// Template names must match exactly what's approved in Meta Business Manager
const TEMPLATES = {
  ORDER_RECEIVED: {
    name: 'order_received',
    language: 'en',
    category: 'UTILITY',
    components: [
      { type: 'BODY', text: 'Hi {{1}}! We received your order (Ref: {{2}}). We\'ll confirm shortly. — {{3}}' }
    ],
    variables: (name: string, ref: string, business: string) => [name, ref, business],
  },
  ORDER_CONFIRMED: { ... },
  ORDER_FULFILLED: { ... },
  PAYMENT_RECEIVED: { ... },
  STOCK_ALERT: { ... },
  OTP_CODE: { ... },
  STAFF_INVITE: { ... },
} as const;
```

## 8.3 Outbound Rate Limiting

```
Meta rate limit: 80 messages/second per phone number
Flowdesk safety limit: 40 messages/second (50% buffer)

BullMQ notifications queue:
  concurrency: 4 workers
  rate limiter: { max: 40, duration: 1000 } (40 per second)

If rate limit hit (Meta 130429):
  Retry with exponential backoff: 2s, 4s, 8s
  If all retries exhausted: log to Sentry, alert ops, mark job failed
```

## 8.4 Meta Error Handler

```typescript
const META_ERROR_ACTIONS: Record<number, 'retry' | 'skip' | 'alert'> = {
  130429: 'retry',   // Rate limit — retry with backoff
  131026: 'skip',    // Recipient not on WhatsApp — mark customer accordingly
  131047: 'retry',   // Outside 24hr window — switch to template and retry
  131051: 'skip',    // Message blocked — log, notify owner
  132000: 'alert',   // Template not found — code bug, alert developer
  100:    'alert',   // Invalid parameter — code bug, alert developer
};
```

---

# PART 9: EDGE CASE RESOLUTION

## 9.1 Meta Webhook Downtime

**Scenario:** WhatsApp itself goes down for 30 minutes. No messages arrive.

**Impact:** No business impact. When WhatsApp recovers, Meta replays undelivered webhooks.

**Flowdesk response:**
- Idempotency check (Redis waMessageId cache) catches replays
- Already-processed messages skipped silently
- No duplicates created
- Health check shows 0 messages processed (owner can see if they check, but WhatsApp downtime is visible to everyone)

## 9.2 Redis Complete Failure

**Scenario:** Redis crashes and doesn't recover within 60 seconds.

**Impact:**
- BullMQ jobs cannot be queued (critical — messages would be lost)
- Haiku cache unavailable (minor — Haiku called every time)
- Reference number generation falls back to timestamp
- SSE pub/sub stops (minor — dashboards stop updating in real time)

**Flowdesk response:**
- Message ingestion: webhook receiver detects Redis unavailable → falls back to storing raw payload in DB with a `pendingRequeue = true` flag → recovery worker picks up on Redis reconnect
- Haiku: called directly every time, no cache
- Reference numbers: timestamp-based (FD-M8K2A3) — unique, readable, just not sequential
- SSE: clients reconnect with exponential backoff. On reconnect, TanStack Query refetches all data
- Redis reconnects: exponential backoff, max 10 attempts, then alert ops

## 9.3 Database Connection Pool Exhaustion

**Scenario:** Traffic spike causes all 10 DB connections to be in use. New queries queue.

**Flowdesk response:**
- Prisma connection timeout: 5000ms. Queries that can't get a connection within 5s throw a timeout error
- BullMQ workers have concurrency limits — prevents runaway DB pressure
- The queue acts as a natural buffer — message ingestion continues (in Redis), DB processing slows but doesn't fail
- Alert: if DB query time p95 exceeds 2s for more than 2 minutes → alert ops → scale up

## 9.4 Duplicate Message Delivery

**Scenario:** Meta's retry logic sends the same webhook twice (network issue during delivery confirmation).

**Flowdesk response:**
```
Inbound:
1. Check Redis: EXISTS waMessageId:{id}
   Hit → return 200 immediately, do nothing (idempotent)
   Miss → process and cache with 24hr TTL

Outbound (auto-reply):
1. Before sending, check Redis: EXISTS sent:{orderId}:{replyType}
   Hit → skip (already sent)
   Miss → send and cache with 24hr TTL
```

## 9.5 Partial Transaction Failure

**Scenario:** Creating an order succeeds but creating order items fails mid-transaction.

**Flowdesk response:**
- All order creation runs in a single `$transaction()` call
- If `createOrderItems` throws, Prisma automatically rolls back `createOrder`
- Worker receives error, logs it, and retries the whole job (up to 3 times)
- Customer does not receive a confirmation reply until the full transaction commits
- After 3 failed retries: job dead-lettered, logged to Sentry, owner sees the message in their review queue but no order created (they can manually create it)

## 9.6 Haiku API Unavailable

**Scenario:** Anthropic API returns 500s or times out for an extended period.

**Flowdesk response:**
- Haiku timeout is set to 3000ms
- On any error: catch, log with context (never rethrow)
- Return: `{ intent: 'UNCLASSIFIED', confidence: 0 }`
- Message marked `requiresReview = true`
- Owner sees the flagged message in their review queue
- Owner manually classifies it (which creates an ORDER if needed)
- Rule engine still handles 80%+ of messages correctly — Haiku's absence degrades experience but doesn't stop operations

## 9.7 Ghana Network Conditions (3G Drops)

**Scenario:** Business owner's phone loses 3G mid-session. Reconnects 2 minutes later.

**Flowdesk response:**
- SSE connection drops → EventSource triggers `onerror`
- Frontend reconnects with exponential backoff
- On reconnect: `queryClient.invalidateQueries()` — all stale data refetched
- Orders created during the disconnect appear immediately on reconnect
- No data lost: all mutations went through the REST API (not SSE), which has retry logic in the HTTP client

## 9.8 Very High Message Volume (Market Days)

**Scenario:** It's a market day. A large distributor's business gets 500 WhatsApp messages in 10 minutes.

**Flowdesk response:**
- Webhook receiver processes each message in < 200ms (DB write + Redis push)
- BullMQ message queue acts as the buffer — jobs pile up without any message loss
- Workers process at their configured concurrency rate
- Processing might lag 5–10 minutes during the spike — acceptable trade-off
- Auto-replies still send in order (notification queue has its own concurrency)
- Dashboard shows new orders as workers complete them (slight delay, still real-time)
- Scaling: worker concurrency can be increased at any time in the BullMQ config without a deployment

## 9.9 Blacklisted Customer Sends Order

**Scenario:** A customer who owes the business money and has been blacklisted sends a new order.

**Flowdesk response:**
- Customer lookup on every inbound message checks `blacklisted` flag
- If `blacklisted = true`:
  - Message still processed and stored
  - Intent classification still runs
  - Order is created with status PENDING (owner decides)
  - But: SSE event carries `{ customerBlacklisted: true }` flag
  - Dashboard: OrderCard shows a red "Blacklisted Customer" badge
  - Auto-reply is suppressed (configurable — owner may want to notify them)
  - Owner manually decides: confirm, cancel, or message customer about outstanding balance

## 9.10 WhatsApp 24-Hour Window Expired — Proactive Message

**Scenario:** Owner wants to send a custom message to a customer who hasn't messaged in 3 days.

**Flowdesk response:**
- Frontend flags the customer as "outside 24hr window"
- Owner's custom message input is blocked with explanation: "This customer hasn't messaged in 3 days. You can only send pre-approved messages."
- Dropdown shows available approved templates
- Owner selects template + fills variables → sends as template message
- Meta charges utility conversation rate (~$0.024 vs $0.044 for service)

## 9.11 Phone Number Change (MNP — Mobile Number Portability)

**Scenario:** A customer changes their number. Their old WhatsApp number no longer works.

**Flowdesk response:**
- Old number: outbound messages will fail with Meta error 131026 (recipient not on WhatsApp)
- Error handler marks customer: `waNumberInvalid = true`
- SSE event: `{ type: 'customer.unreachable', data: { customerId, waNumber } }`
- Dashboard alert on customer profile: "This number may be invalid. Outbound messages are failing."
- Owner can update the customer's number from the customer profile page
- Historical orders and payments remain linked to the customer record

## 9.12 Business Owner Changes WhatsApp Number

**Scenario:** The business gets a new phone number and wants to migrate Flowdesk to the new number.

**Flowdesk response:**
- This requires Meta Business Manager action (cannot be done via Flowdesk UI alone)
- Process documented in WHATSAPP-SETUP.md:
  1. Add new number in Meta Business Manager
  2. Flowdesk settings: disconnect old number, connect new number
  3. All historical data remains (businessId doesn't change)
  4. New messages route through new number
  5. Old number's conversation window naturally expires

## 9.13 Staff Member Attempts Privilege Escalation

**Scenario:** A DELIVERY staff member modifies their JWT (or intercepts a manager's token) and tries to access financial data.

**Flowdesk response:**
- Auth middleware validates JWT signature — tampered tokens fail HMAC verification immediately
- Role is in the JWT payload — the role cannot be changed without the server's JWT secret
- Role check middleware validates `role` claim against endpoint requirements
- Repository functions also check `businessId` — cross-business access impossible even with a valid stolen token from another business
- Staff can only see their own business's data regardless of role
- All access attempts logged with staffId, role, endpoint, timestamp

## 9.14 Product Catalog Not Set Up (New Business)

**Scenario:** A brand new business connects Flowdesk but hasn't added products yet. Customer sends an order.

**Flowdesk response:**
- Order is still created — catalog matching returns 0 matched items
- All items stored as description-only (no productId, no unitPrice, no subtotal)
- Total amount shows as 0 (no pricing data)
- Order appears on dashboard with a "⚠ Items not matched to catalog" badge
- Owner confirms order manually, sets items and prices from the order detail drawer
- Auto-reply still sends: "We received your order (Ref: FD-00001). We'll confirm shortly."
- Dashboard prompt: "You have 5 unmatched order items. Add products to your catalog to enable automatic pricing."

## 9.15 Concurrent Status Update Race Condition

**Scenario:** Owner and a manager both click "Confirm" on the same order at the same time from different devices.

**Flowdesk response:**
- First request wins: updates status to CONFIRMED
- Second request: `findOrderById` returns status=CONFIRMED
- Validation: "Cannot transition from CONFIRMED to CONFIRMED" → 409 Conflict
- Second request returns `{ success: false, error: "Order already confirmed", code: "INVALID_STATE_TRANSITION" }`
- Both dashboards update via SSE: order shows CONFIRMED
- No duplicate stock deductions (deduction job is idempotent — checks if already done via a `stockDeducted` flag on the order)

## 9.16 Business Account Suspended (Non-Payment)

**Scenario:** Business doesn't pay their Paystack subscription. Trial expires.

**Flowdesk response:**
```
T+0      Trial end date reached
T+0      Paystack subscription.disabled webhook fires
T+5min   Flowdesk updates business.plan = 'SUSPENDED'
T+6min   Next API request from owner returns 402 with clear message
         { error: "Your trial has expired. Please upgrade to continue.", code: "ACCOUNT_SUSPENDED" }
T+6min   Dashboard shows full-screen modal: "Upgrade to continue"
T+6min   Inbound messages: STILL STORED (never lose customer data)
T+6min   Outbound auto-replies: PAUSED (no messages sent while suspended)
T+6min   Workers: skip processing for suspended businessId

If business reactivates within 30 days:
  All queued messages processed
  All stored data intact
  Resumes normally

After 30 days of suspension:
  Data flagged for deletion (30-day warning email first)
  Owner can download export at any time during this window
```

## 9.17 Extremely Long Customer Message

**Scenario:** Customer sends a 2000-character message (WhatsApp maximum is ~4096 chars).

**Flowdesk response:**
- Full message stored in DB (TEXT type — no length limit in PostgreSQL for this column)
- Intent classification: first 500 characters sent to Haiku (most signal-dense section)
- Rule engine: runs on full text (regex on strings is fast regardless of length)
- Item extraction: runs on full text
- Order created with raw message stored in full
- Dashboard order card shows first 150 characters with "..." truncation

## 9.18 Unicode and Character Encoding (Twi Characters)

**Scenario:** Customer sends a message with Twi characters: "Mepɛ rice 3 bags" (ɛ = Latin Small Letter Open E, U+025B).

**Flowdesk response:**
- PostgreSQL TEXT columns store full Unicode — no issues
- WhatsApp supports full Unicode in messages
- Twi-specific characters (ɛ, ɔ, etc.) stored and displayed correctly
- Rule engine patterns include Unicode-aware Twi matches
- Meta API: WhatsApp messages are UTF-16 encoded — the SDK handles this transparently
- DM Sans font (chosen for UI) includes Latin Extended characters needed for Twi

---

# PART 10: SECURITY ARCHITECTURE

## 10.1 Threat Model

```
Threat                    │ Vector                   │ Mitigation
──────────────────────────┼──────────────────────────┼──────────────────────────────
Webhook spoofing          │ Fake POST to /webhook    │ HMAC-SHA256 + timingSafeEqual
SSRF                      │ Media URL manipulation   │ Only fetch from graph.facebook.com
SQL injection             │ Malicious order text     │ Prisma ORM (parameterized only)
XSS                       │ Stored message content   │ React escapes all content by default
JWT forgery               │ Modified token payload   │ HMAC signature (HS256, 64-char secret)
Refresh token theft       │ Cookie/local storage theft│ HttpOnly cookie (MVP: bearer, Phase 2: cookie)
Brute force OTP           │ Enumeration attack       │ 5 attempts → lockout, 10min TTL
Brute force login         │ Password enumeration     │ bcrypt cost 12, rate limit 5/15min
IDOR                      │ Modify order by ID       │ businessId check on every query
Cross-tenant access       │ Stolen token             │ businessId in JWT + DB WHERE clause
DDoS                      │ Flooding /webhook        │ Cloudflare + app-level rate limiting
Credential exposure       │ Git commit               │ .env.example only, pre-commit hook
Timing attack             │ HMAC comparison          │ crypto.timingSafeEqual everywhere
Webhook replay            │ Resend captured payload  │ waMessageId idempotency + 24h TTL
```

## 10.2 Secret Rotation Plan

```
META_ACCESS_TOKEN:   Rotate every 90 days (Meta system user tokens don't expire
                     automatically, but rotate as good practice)
JWT_SECRET:          Rotate every 180 days (requires all users to re-login)
JWT_REFRESH_SECRET:  Rotate every 180 days (same as above)
ANTHROPIC_API_KEY:   Rotate every 90 days or immediately if suspected compromise
PAYSTACK_SECRET_KEY: Rotate every 180 days
DATABASE_URL:        Rotate password every 90 days
```

## 10.3 API Security Headers

```
Configured via @fastify/helmet:
  Content-Security-Policy:
    default-src 'self'
    script-src 'self' 'unsafe-inline' (required by Vite HMR in dev only)
    style-src 'self' 'unsafe-inline' fonts.googleapis.com
    font-src fonts.gstatic.com
    connect-src 'self' wss: (SSE)
    img-src 'self' data: *.cloudfront.net
  Strict-Transport-Security: max-age=31536000; includeSubDomains
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: strict-origin-when-cross-origin
```

---

# PART 11: MONITORING ARCHITECTURE

## 11.1 Logging Strategy

```
Every log line contains:
  timestamp    UTC ISO 8601
  level        debug|info|warn|error
  service      api|worker:messages|worker:intent|worker:orders|worker:notifications
  businessId   (when applicable, never for public endpoints)
  traceId      UUID per request chain (passed through queue jobs)

Request logs (every HTTP request):
  method, path, statusCode, duration, businessId, userAgent

Worker logs (every job):
  queue, jobId, businessId, duration, outcome, retryCount

External API logs (every outbound call):
  service, endpoint, statusCode, duration, businessId

Error logs (every caught exception):
  error.message, error.stack, context object, businessId, jobId
```

## 11.2 Health Check Detail

```
GET /health returns:

{
  "status": "ok" | "degraded" | "down",
  "timestamp": "2025-01-15T10:30:00Z",
  "uptime": 86423,
  "version": "1.0.0",
  "checks": {
    "database": {
      "status": "ok",
      "responseTime": 12,
      "connections": { "active": 3, "idle": 7, "max": 10 }
    },
    "redis": {
      "status": "ok",
      "responseTime": 1,
      "memoryUsedMb": 45
    },
    "queues": {
      "messages":      { "waiting": 0,  "active": 2,  "failed": 0 },
      "intent":        { "waiting": 3,  "active": 2,  "failed": 0 },
      "orders":        { "waiting": 1,  "active": 1,  "failed": 0 },
      "notifications": { "waiting": 8,  "active": 4,  "failed": 0 }
    },
    "meta_api": {
      "status": "ok",
      "lastCheck": "2025-01-15T10:29:45Z"
    }
  }
}

Status logic:
  all checks ok → status: "ok"
  non-critical check degraded → status: "degraded"
  database or redis down → status: "down"
```

---

# PART 12: DEPLOYMENT ARCHITECTURE

## Phase 1 MVP (Current)

```
EC2 t3.medium
├── Cloudflare (DNS, SSL, DDoS)
├── Nginx (reverse proxy)
│   ├── → :3001 (Fastify API)
│   └── → :5173/dist (React static)
├── PM2
│   ├── api          (2 cluster instances, Fastify)
│   └── workers      (1 instance, all BullMQ workers)
├── PostgreSQL 15    (same server)
└── Redis 7          (same server)

Estimated capacity: ~500 active businesses, ~50,000 messages/day
```

## Phase 2 (100+ businesses)

```
Cloudflare
    │
    ▼
AWS ALB (Application Load Balancer)
    ├── ECS Fargate: api (min 2, max 8 tasks, scale on CPU/request count)
    └── ECS Fargate: workers (min 2, max 6 tasks, scale on queue depth)

AWS RDS PostgreSQL 15
  Multi-AZ: yes
  Read replicas: 1 (for reports and analytics queries)
  Instance: db.t3.medium → db.r5.large at scale

AWS ElastiCache Redis 7
  Cluster mode: enabled
  3 shards × 2 replicas

AWS S3 (af-south-1)
  Bucket: flowdesk-uploads-prod
  Lifecycle: screenshots expire after 1 year

AWS CloudWatch
  Log groups per service
  Custom metrics: messages/min, queue depth, error rate
  Alarms → SNS → email + Slack
```

## Deployment Process

```bash
# Zero-downtime deployment (PM2, Phase 1)
git pull origin main
pnpm build
pnpm prisma migrate deploy   # Run migrations first, always
pm2 reload ecosystem.config.js --update-env

# Zero-downtime deployment (ECS, Phase 2)
# GitHub Actions:
  1. Build Docker image
  2. Push to ECR
  3. Run migrations (ECS task, terminates after completion)
  4. Update ECS service (rolling deployment — ECS handles zero-downtime)
```
