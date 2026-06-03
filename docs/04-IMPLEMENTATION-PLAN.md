# Flowdesk — Implementation Plan
**Format:** Phase → Tasks → Acceptance Criteria → Done When  
**Discipline:** A phase is not complete until every acceptance criterion is met. No moving on with known gaps.

---

## Phase 0 — Foundation (Days 1–2)

**Goal:** A working monorepo where AI can write real code from minute one. No configuration debt. No "we'll sort that later."

### Tasks

| # | Task | Notes |
|---|------|-------|
| 0.1 | Initialize pnpm monorepo with Turborepo | pnpm-workspace.yaml, turbo.json, root package.json |
| 0.2 | Create apps/api scaffold | Fastify 4, TypeScript, Prisma, Zod |
| 0.3 | Create apps/web scaffold | Vite, React 18, TypeScript, Tailwind, shadcn |
| 0.4 | Create packages/shared | Shared types between api and web |
| 0.5 | Docker Compose for local Postgres + Redis | With health checks |
| 0.6 | Environment variable validation (Zod) in api | Fails with clear error on missing vars |
| 0.7 | Pino logger configured | Pretty in dev, JSON in prod |
| 0.8 | Prisma schema written and migrated | All models from PRD |
| 0.9 | ESLint + Prettier at root level | Shared config across apps |
| 0.10 | GitHub repo + CI workflow | Lint + typecheck on every PR |
| 0.11 | PM2 ecosystem file | For production EC2 deployment |
| 0.12 | setup.sh script | One command to get dev running |

### Done When
- `pnpm dev` starts both apps
- Postgres and Redis connect successfully
- `pnpm prisma migrate dev` runs clean with no errors
- TypeScript compiles with zero errors across all packages
- ESLint passes with zero warnings

---

## Phase 1 — Webhook Foundation (Days 3–6)

**Goal:** Receive, validate, store, and queue every incoming WhatsApp message. Zero message loss. The foundation everything else builds on.

### Tasks

| # | Task | Notes |
|---|------|-------|
| 1.1 | Meta webhook verification endpoint (GET /webhook) | hub.mode, hub.verify_token, hub.challenge |
| 1.2 | Meta webhook receiver endpoint (POST /webhook) | Returns 200 in <500ms always |
| 1.3 | HMAC-SHA256 signature validation | crypto.timingSafeEqual — no exceptions |
| 1.4 | Raw message stored before any processing | Immediate DB write on receipt |
| 1.5 | BullMQ message queue definition | Queue name, job types, retry config |
| 1.6 | Job pushed to queue after storage | Decouples receipt from processing |
| 1.7 | Message Processor Worker scaffold | Picks up jobs, parses payload, upserts customer |
| 1.8 | WhatsApp payload parser | Handles all message types (text, image, audio, etc.) |
| 1.9 | Customer upsert on first message | Normalizes Ghana phone numbers |
| 1.10 | Webhook payload TypeScript types | Full Meta payload structure typed |
| 1.11 | Test fixtures | Real Meta webhook payload samples for testing |
| 1.12 | Integration tests | Webhook validation, storage, queue push |

### Acceptance Criteria
- Real WhatsApp message received → stored in DB within 2 seconds
- Webhook with invalid HMAC signature → 401, attempt logged
- Meta verification GET request → correct challenge returned
- Worker processes job and upserts customer record
- Duplicate waMessageId → detected and skipped (idempotent)
- Worker failure → job retried up to 3 times with exponential backoff
- Worker exhausts retries → job marked failed, logged, not silently dropped

### Done When
Send a real WhatsApp message to the connected number. Open the database. The message row exists with `processed: false`. Open the BullMQ dashboard (bull-board). The job exists and has been processed. The customer row exists or was updated.

---

## Phase 2 — Intent Engine (Days 7–10)

**Goal:** Every text message gets classified accurately. No wrong action taken on a wrong classification.

### Tasks

| # | Task | Notes |
|---|------|-------|
| 2.1 | Rule engine — keyword + pattern matching | All patterns from PRD section F-003 |
| 2.2 | Confidence scoring system | 0.0 to 1.0, pattern count and weight |
| 2.3 | Ambiguity penalty | Multiple competing intents reduce confidence |
| 2.4 | Text normalization | Trim, lowercase, collapse whitespace before matching |
| 2.5 | Ghanaian English patterns | Pidgin, Twi-English, abbreviations |
| 2.6 | Claude Haiku integration | For confidence < 0.75 |
| 2.7 | Haiku result Redis cache | 24hr TTL, keyed by SHA256 of text |
| 2.8 | Haiku timeout handling | 3s timeout, falls back gracefully |
| 2.9 | Intent classification worker | Picks up from message queue, runs classification |
| 2.10 | Message updated with intent + confidence + source | RULE_ENGINE or HAIKU or MANUAL |
| 2.11 | Manual review flagging | Low confidence → requiresReview: true |
| 2.12 | Owner correction endpoint | PATCH /messages/:id/intent — updates and marks as MANUAL |
| 2.13 | Unit tests | 200+ test cases, English + Pidgin + Twi-English |

### Test Case Requirements
Tests must cover:
- Standard English orders ("I want 3 bags of rice")
- Pidgin orders ("Abeg make I get 2 cartons Malta")
- Twi-English orders ("Mepɛ rice 3 bags")
- Payment notifications (all three MoMo networks)
- Status checks with reference numbers ("What happened to FD-00234?")
- Complaints ("I received the wrong thing")
- Greetings (various)
- Ambiguous messages that should trigger Haiku
- Very short messages ("Okay", "Thanks")
- Emoji-only messages
- Voice note (non-text — should skip classification)

### Acceptance Criteria
- ≥90% accuracy on the 200-message test set
- Rule engine response time <200ms
- Haiku fallback response time <3 seconds
- Haiku failure (timeout/API error) handled gracefully → UNCLASSIFIED, no crash
- Haiku results cached — same message text hits cache on second request

### Done When
Run the full test suite. 180+ of 200 test cases pass. Zero unhandled exceptions. Haiku is never called when rule engine confidence is ≥0.75.

---

## Phase 3 — Order Pipeline (Days 11–16)

**Goal:** Detected ORDER messages become tracked records. Customer receives confirmation. Dashboard updates in real time.

### Tasks

| # | Task | Notes |
|---|------|-------|
| 3.1 | Order creation service | Full business logic |
| 3.2 | Reference number generation | FD-00001, Redis INCR, timestamp fallback |
| 3.3 | Item extraction from raw text | Best-effort, never blocks order creation |
| 3.4 | Product catalog fuzzy matching | Levenshtein distance ≥0.75 threshold |
| 3.5 | Unmatched items stored as description-only | No product link, no price calculated |
| 3.6 | Order + OrderItems DB transaction | Atomic — both or neither |
| 3.7 | Stock deduction on CONFIRMED | Not on PENDING — prevents premature deduction |
| 3.8 | Status machine implementation | PENDING → CONFIRMED → PROCESSING → FULFILLED |
| 3.9 | OrderStatusHistory on every transition | Immutable audit trail |
| 3.10 | Auto-reply trigger on order creation | Job pushed to notification queue |
| 3.11 | Auto-reply trigger on status change | Customer notified on every transition |
| 3.12 | SSE event on order creation | Dashboard updates in real time |
| 3.13 | SSE event on status change | Card moves columns in real time |
| 3.14 | Order routes (CRUD + status) | GET, PATCH status, POST manual |
| 3.15 | Order repository | All Prisma queries, businessId-scoped |
| 3.16 | Manual order creation | Walk-in customers without WA message |
| 3.17 | Order assignment to staff | PATCH /orders/:id/assign |
| 3.18 | Order cancellation with reason | Sets cancelledAt and cancelReason |

### Acceptance Criteria
- Customer sends WhatsApp order → order appears on dashboard within 3 seconds
- Reference number unique per business, incrementing, never reused
- Customer receives confirmation with reference number
- Order status change → customer notified within 5 seconds
- Order status change → dashboard updates without page refresh
- Manual order creation works for walk-in customers
- Stock quantity deducts only when order moves to CONFIRMED
- Status history records every transition with timestamp and actor

### Done When
End-to-end test: customer sends "I want 3 bags of rice" → order FD-00001 appears on dashboard → owner taps Confirm → customer receives WhatsApp confirmation → stock for rice decrements by 3.

---

## Phase 4 — Authentication (Days 17–20)

**Goal:** Secure auth. Business onboarding in under 5 minutes. Staff management works.

### Tasks

| # | Task | Notes |
|---|------|-------|
| 4.1 | Business registration endpoint | Name, owner name, phone |
| 4.2 | OTP generation and storage | Redis, 6 digits, 10min expiry |
| 4.3 | OTP delivery via WhatsApp | Use business's own Meta API connection |
| 4.4 | Login endpoint | Phone + OTP → access token + refresh token |
| 4.5 | JWT middleware | Validates token, injects businessId to request |
| 4.6 | Business context middleware | Every protected route has businessId |
| 4.7 | Token refresh endpoint | Rotates both tokens |
| 4.8 | Logout endpoint | Deletes session record |
| 4.9 | Session model and repository | Stores refresh tokens |
| 4.10 | WhatsApp number connection wizard | Step-by-step Meta Business verification |
| 4.11 | Staff invitation | POST /staff → sends WhatsApp invite link |
| 4.12 | Staff invite acceptance | GET /staff/invite/:token → set password |
| 4.13 | Staff login | Phone + password → scoped token |
| 4.14 | Role middleware | Enforces MANAGER/OPERATIONS/DELIVERY permissions |
| 4.15 | Rate limit on login | 5 attempts per phone per 15 minutes |

### Acceptance Criteria
- Owner registers → connects WhatsApp number → logged in within 5 minutes
- Staff invitation sent via WhatsApp
- Staff accepts invite, sets password, logs in
- Staff can only see data permitted by their role (server-side, not just UI)
- Expired or invalid token → 401
- Invalid OTP → 401
- Rate limit hit → 429 with retry-after header
- Refresh token rotation works on every use

### Done When
Full auth flow from registration to WhatsApp connection to staff invite to role-scoped dashboard — all working, all tested.

---

## Phase 5 — Dashboard (Days 21–28)

**Goal:** Clean, fast, real-time dashboard that works on a 3G connection and a mid-range Android phone.

### Pages and Components

#### Dashboard Home
- Today's orders (count + total value)
- Pending orders list — real-time, most recent first
- Messages flagged for review
- Revenue summary (today / this week / this month)
- Low stock alerts
- Outstanding payment alerts

#### Orders Page
- Desktop: Kanban board (PENDING | CONFIRMED | PROCESSING | FULFILLED)
- Mobile: Tabbed list view
- Filter: date range, assigned staff, search by reference or customer name
- New Order button (manual entry modal)
- Real-time: new orders append instantly

#### Order Detail Drawer
- Full order info
- Items with quantities and prices
- Customer card with link to profile
- Status timeline (history)
- Staff assignment dropdown
- Action buttons (Confirm / Processing / Fulfilled / Cancel)
- Inline payment logging
- WhatsApp quick-reply link

#### Customers Page
- Table: name, number, orders, total spend, balance, last active
- Click → customer profile (all orders, payments, running balance)
- Search by name or number
- Export CSV
- Tags display and edit

#### Products Page
- List with stock levels (color coded: green/amber/red)
- Add/edit product modal
- Stock adjustment (add or subtract)
- Reorder threshold setting
- CSV import

#### Payments Page
- Payment log with filters
- Screenshot review queue (flagged payment screenshots awaiting confirmation)
- Confirm screenshot → set amount → link to order → sends receipt

#### Messages Page
- All inbound messages chronological
- Manual review queue (requiresReview: true)
- Correct misclassification (sets correct intent, marks as MANUAL)

#### Settings Page
- Auto-reply template editor with variable preview
- Staff management (invite, edit role, deactivate)
- Plan and billing (Paystack integration)
- Business profile (name, number)

### Acceptance Criteria
- Dashboard loads in <4 seconds on simulated 3G (Chrome DevTools throttling)
- All pages functional with real data
- All pages render correctly at 375px width
- New orders appear without refresh (SSE)
- All lists show loading skeletons, not spinners
- All API errors show user-friendly messages
- Empty states designed and implemented for every list

### Done When
Full dashboard walkthrough with real WhatsApp messages, real orders, real payments — everything works on a physical Android phone on mobile data.

---

## Phase 6 — Payments & Inventory (Days 29–33)

**Goal:** Accurate payment tracking. Accurate inventory. Automated alerts.

### Tasks

| # | Task | Notes |
|---|------|-------|
| 6.1 | Manual payment logging API | Amount, method, reference, order link |
| 6.2 | Customer balance calculation | Outstanding = orders confirmed - payments verified |
| 6.3 | MoMo screenshot detection | Is this image a payment screenshot? |
| 6.4 | Screenshot storage to S3 | Pre-signed URL upload, thumbnail generation |
| 6.5 | Screenshot review queue | Flag on dashboard, one-tap confirm |
| 6.6 | Payment receipt auto-send | After confirmation, WhatsApp receipt to customer |
| 6.7 | Inventory deduction on CONFIRMED | Transaction-safe |
| 6.8 | Inventory alert worker | Check threshold after every deduction |
| 6.9 | Low stock WhatsApp alert to owner | Template message with product name and qty |
| 6.10 | Stock adjustment endpoint | Manual add/subtract with reason |
| 6.11 | Revenue reports API | Day/week/month totals with breakdown |
| 6.12 | Payment method breakdown | MoMo vs Cash vs Bank per period |

### Acceptance Criteria
- Customer sends MoMo screenshot → flagged in review queue within 3 seconds
- Owner confirms screenshot → customer receives receipt automatically
- Customer balance accurate across multiple orders and partial payments
- Stock level decrements atomically with order confirmation
- Owner receives WhatsApp alert when stock hits reorder threshold
- Revenue numbers match manual calculation

### Done When
Full payment flow: customer sends MoMo screenshot → owner confirms → balance updates → receipt sent → inventory decrements → low stock alert fires if needed.

---

## Phase 7 — Hardening (Days 34–38)

**Goal:** Production-ready. No known vulnerabilities. No uncaught errors. Handles unexpected inputs without crashing.

### Tasks

| # | Task | Notes |
|---|------|-------|
| 7.1 | Sentry integration | Both api and web |
| 7.2 | Global error handler in Fastify | All unhandled errors caught, formatted, logged |
| 7.3 | Graceful shutdown | SIGTERM/SIGINT → drain queues, close DB, close Redis |
| 7.4 | Health check endpoint | DB + Redis + queue depth |
| 7.5 | BullMQ dead letter review | Daily job to log and alert on failed jobs |
| 7.6 | Webhook retry handling | Meta retries failed deliveries — idempotency check |
| 7.7 | Duplicate message detection | waMessageId uniqueness enforced at DB level |
| 7.8 | Rate limiting verification | All limits in place and tested |
| 7.9 | Security headers | Helmet, CORS locked to allowed origins |
| 7.10 | Load test | 1000 concurrent webhook requests |
| 7.11 | TypeScript strict compliance | Zero errors with strict: true, noUncheckedIndexedAccess: true |
| 7.12 | All TODO comments resolved | None allowed in production code |
| 7.13 | Environment variable validation | Startup fails clearly on any missing required variable |
| 7.14 | 48hr soak test | Run with real traffic, monitor Sentry |

### Acceptance Criteria
- Load test: 1000 concurrent webhook requests processed with zero message loss
- Sentry shows zero unhandled errors after 48hr of real traffic
- Invalid webhook signature never processes a message
- Graceful shutdown completes within 30 seconds
- Health check accurately reflects DB and Redis status
- No TypeScript errors, no ESLint warnings

---

## Phase 8 — Billing (Days 39–41)

**Goal:** Revenue flowing in. Plan limits enforced.

### Tasks

| # | Task | Notes |
|---|------|-------|
| 8.1 | Paystack plans created | Starter (GHS 150), Business (GHS 350), Growth (GHS 700) |
| 8.2 | Subscription creation on registration | 14-day trial, then auto-billing |
| 8.3 | Paystack webhook | payment.success, subscription.cancel, charge.failed |
| 8.4 | Plan enforcement middleware | Blocks API calls when plan limit exceeded |
| 8.5 | Conversation count tracking | Monthly counter per business, resets on billing cycle |
| 8.6 | Trial expiry handling | Dashboard warning at 3 days, block on expiry |
| 8.7 | Billing page in dashboard | Current plan, usage, upgrade/downgrade, payment history |
| 8.8 | Plan upgrade/downgrade | Immediate effect on limits |

### Plan Limits

| Feature | Starter | Business | Growth |
|---------|---------|----------|--------|
| Price (GHS/mo) | 150 | 350 | 700 |
| WA Conversations/mo | 500 | 2,000 | 10,000 |
| Orders/mo | 300 | Unlimited | Unlimited |
| Staff seats | 1 | 5 | 20 |
| Product catalog | 50 items | Unlimited | Unlimited |
| CSV exports | No | Yes | Yes |
| Analytics | No | Basic | Full |

### Done When
Full billing cycle tested: trial → expiry warning → payment → plan active → limit enforcement → upgrade flow.

---

## Execution Rules

1. **No phase starts until the previous phase's "Done When" criteria are met.** No exceptions. No "we'll come back to it."

2. **Each task has a ticket in the issue tracker.** No undocumented work.

3. **Tests are written before the task is marked done.** Not after.

4. **AI output is reviewed before merging.** Run through the rejection criteria in 03-CODING-RULES.md before every merge.

5. **The main branch is always deployable.** If it's broken, fix it before adding more.
