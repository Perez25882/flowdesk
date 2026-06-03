# Flowdesk Implementation Audit

## Executive Summary

**Status:** Core order pipeline, auth, SSE real-time, and dashboard shell are implemented.
**Gap:** Payment module, product catalog, customer management, staff RBAC, and several dashboard pages are missing or stubbed.

---

## Module-by-Module Audit

### 1. AUTHENTICATION & BUSINESS MANAGEMENT

| Requirement | Status | File(s) | Notes |
|-------------|--------|---------|-------|
| Business registration endpoint | ✅ | `auth.route.ts`, `auth.service.ts`, `auth.repository.ts` | Creates business + Paystack customer + 14-day trial |
| OTP login (6 digits, 5-min TTL, 3 attempts) | ✅ | `auth.service.ts` | Redis-backed, normalized Ghana phone format |
| JWT access (15m) + refresh (7d) tokens | ✅ | `auth.service.ts`, `auth.middleware.ts` | Refresh token rotation with SHA256 hash in DB |
| Token rotation on refresh | ✅ | `auth.service.ts` | Old refresh token invalidated, new hash stored |
| Auth middleware (requireAuth, optionalAuth) | ✅ | `auth.middleware.ts`, `business-context.middleware.ts` | 401/403/402 responses per spec |
| Session management (Prisma Session table) | ✅ | `auth.repository.ts` | Stores device info, IP, user agent |
| Logout / Logout-all endpoints | ✅ | `auth.route.ts` | Deletes session(s) from DB |
| Staff invitation flow | ❌ | — | Not implemented |
| Staff invite acceptance + password set | ❌ | — | Not implemented |
| Staff login (phone + password) | ❌ | — | Not implemented |
| Role-based access control middleware | ⚠️ | `business-context.middleware.ts` | Attaches role to request but no endpoint-level enforcement yet |
| WhatsApp number connection wizard | ❌ | — | Not implemented |

**Verdict:** Core auth (owner login) complete. Staff management missing entirely.

---

### 2. WEBHOOK & MESSAGE INGESTION

| Requirement | Status | File(s) | Notes |
|-------------|--------|---------|-------|
| Meta webhook verification (GET /webhook) | ✅ | `webhook.route.ts`, `webhook.service.ts` | Challenge response |
| Meta webhook receiver (POST /webhook) | ✅ | `webhook.route.ts` | Returns 200, queues message |
| HMAC-SHA256 signature validation | ✅ | `webhook.service.ts` | Timing-safe comparison |
| Raw message stored before processing | ✅ | `webhook.route.ts` | Upsert on waMessageId |
| BullMQ queue setup | ✅ | `message.queue.ts` | `incomingMessagesQueue` configured |
| Message processor worker | ✅ | `message-processor.worker.ts` | Processes messages, creates customer, queues intent classification |
| Customer auto-creation on first message | ✅ | `message-processor.worker.ts` | Upsert by businessId + waNumber |
| Duplicate handling (idempotency on waMessageId) | ✅ | `webhook.route.ts` | Redis dedup cache |
| Dead letter queue for failed jobs | ⚠️ | `message.queue.ts` | `removeOnFail: false` — no explicit DLQ processor |

**Verdict:** Phase 1 (webhook foundation) complete. DLQ processor is a minor gap.

---

### 3. INTENT CLASSIFICATION

| Requirement | Status | File(s) | Notes |
|-------------|--------|---------|-------|
| Rule engine — keyword + pattern matching | ✅ | `rule-engine.ts` | 7 intents with keyword sets |
| Ghanaian English / Pidgin / Twi patterns | ✅ | `rule-engine.ts` | Keywords include local terms |
| Confidence scoring (0.0–1.0) | ✅ | `rule-engine.ts` | Returns confidence per intent |
| Claude Haiku API integration | ✅ | `haiku-classifier.ts` | Falls back when rule engine confidence < threshold |
| Redis caching of Haiku results | ✅ | `haiku-classifier.ts` | TTL configured |
| Haiku timeout (3000ms) | ✅ | `haiku-classifier.ts` | AbortController with timeout |
| Manual review flagging | ⚠️ | `message-processor.worker.ts` | Messages with body < 3 chars flagged; full confidence-based flagging not wired |
| Correction endpoint | ❌ | — | Not implemented |
| Unit test suite (200+ cases) | ⚠️ | `rule-engine.test.ts` | Exists but coverage unknown |

**Verdict:** Core engine complete. Review queue and correction endpoint missing.

---

### 4. ORDER MANAGEMENT

| Requirement | Status | File(s) | Notes |
|-------------|--------|---------|-------|
| Reference number generator (FD-00001) | ✅ | `order-reference.ts` | Redis INCR with per-business atomic counter, timestamp fallback |
| Item extractor from raw text | ✅ | `item-extractor.ts` | Fuzzy matching with Levenshtein distance |
| Fuzzy product catalog matching | ✅ | `item-extractor.ts` | Matches against product name + aliases |
| Order creation (transaction: order + items) | ✅ | `orders.repository.ts` | Prisma transaction wrapper |
| Auto-reply after order creation | ✅ | `orders.service.ts` | WhatsApp confirmation sent |
| Order status machine (valid transitions) | ✅ | `orders.service.ts` | Validation before each transition |
| Status change history logging | ✅ | `orders.repository.ts` | `OrderStatusHistory` records created |
| Customer notification on status change | ✅ | `orders.service.ts` | WhatsApp message per transition |
| SSE event on every order event | ✅ | `sse.events.ts`, `orders.service.ts` | `emitOrderCreated`, `emitOrderUpdated` wired |
| Manual order creation endpoint | ✅ | `orders.route.ts`, `orders.service.ts` | `POST /orders` with Zod validation |
| Order assignment to staff | ✅ | `orders.route.ts`, `orders.schema.ts` | `PATCH /orders/:id/assign` |
| Stock deduction on CONFIRMED | ❌ | — | **NOT IMPLEMENTED** — no inventory service exists |
| Orders API (CRUD + list + stats) | ✅ | `orders.route.ts`, `orders.repository.ts` | Full CRUD with filters, pagination, stats |
| Bulk status update | ❌ | — | Not implemented |
| Order editing (parsed details) | ❌ | — | Not implemented |

**Verdict:** Core order pipeline complete. Stock deduction and bulk operations missing.

---

### 5. REAL-TIME DASHBOARD (FRONTEND)

| Requirement | Status | File(s) | Notes |
|-------------|--------|---------|-------|
| Design system (CSS variables, tokens) | ✅ | `globals.css`, `tailwind.config.js` | Full color/font/spacing/radius token system |
| Layout: sidebar (desktop) + bottom nav (mobile) | ✅ | `Layout.tsx`, `Sidebar.tsx`, `BottomNav.tsx` | Collapsible sidebar, responsive breakpoints |
| SSE singleton hook with auto-reconnect | ✅ | `useSSE.ts` | Exponential backoff, `subscribe`/`unsubscribe` API |
| Orders page — Kanban board | ✅ | `OrderBoard.tsx`, `OrderCard.tsx` | `@dnd-kit/core` drag-and-drop, 4 columns |
| Order detail drawer | ✅ | `OrderDetailDrawer.tsx` | Customer info, items, timeline, actions, payment form |
| Manual order creation modal | ✅ | `ManualOrderModal.tsx` | Catalog + free-text items, live total |
| Skeleton loaders | ✅ | `OrderBoard.tsx`, `Orders.tsx` | 3 skeleton cards per column |
| Empty states | ✅ | `EmptyState.tsx` | Used in all list/board contexts |
| Error states | ⚠️ | — | Error UI exists but no global error boundary |
| Mobile layout tested at 375px | ⚠️ | — | Responsive classes used, not physically tested |
| Login page | ❌ | — | Not implemented |
| Onboarding / WhatsApp wizard | ❌ | — | Not implemented |
| Dashboard home page | ❌ | — | Placeholder only |
| Customers page | ❌ | — | Placeholder only |
| Customer profile page | ❌ | — | Not implemented |
| Products page | ❌ | — | Placeholder only |
| Payments page | ❌ | — | Placeholder only |
| Messages page | ❌ | — | Placeholder only |
| Staff page | ❌ | — | Placeholder only |
| Settings page | ❌ | — | Placeholder only |

**Verdict:** Design system and Orders page complete. 7 of 8 dashboard pages are placeholders.

---

### 6. SERVER-SENT EVENTS (SSE)

| Requirement | Status | File(s) | Notes |
|-------------|--------|---------|-------|
| SSE Manager singleton | ✅ | `sse.manager.ts` | `Map<businessId, Map<id, FastifyReply>>` |
| Connection add/remove | ✅ | `sse.manager.ts` | UUID generation, cleanup on close |
| Broadcast with dead connection cleanup | ✅ | `sse.manager.ts` | Catches write errors, removes dead connections |
| Heartbeat (`: heartbeat\n\n`) | ✅ | `sse.manager.ts` | 30-second interval |
| Typed event emitters (5 event types) | ✅ | `sse.events.ts` | `order.created`, `order.updated`, `message.flagged`, `stock.alert`, `payment.confirmed` |
| SSE route (`GET /sse/connect?token=xxx`) | ✅ | `sse.route.ts` | Direct JWT verification, proper headers, never closes |
| Browser hook (singleton, auto-reconnect) | ✅ | `useSSE.ts` | Module-level `EventSource`, exponential backoff 1s→30s |
| Integration in orders.service | ✅ | `orders.service.ts` | All status changes emit SSE |
| Integration in message processor | ✅ | `message-processor.worker.ts` | Ambiguous messages emit `message.flagged` |

**Verdict:** Fully implemented per spec.

---

### 7. PAYMENT TRACKING

| Requirement | Status | File(s) | Notes |
|-------------|--------|---------|-------|
| Manual payment logging API | ❌ | — | **NOT IMPLEMENTED** |
| Customer balance recalculation | ❌ | — | **NOT IMPLEMENTED** |
| MoMo screenshot detection | ❌ | — | **NOT IMPLEMENTED** |
| Screenshot upload to S3 | ❌ | — | **NOT IMPLEMENTED** |
| Screenshot review queue UI | ❌ | — | **NOT IMPLEMENTED** |
| Owner confirms → payment logged | ❌ | — | **NOT IMPLEMENTED** |
| Payment receipt auto-sent | ❌ | — | **NOT IMPLEMENTED** |
| Revenue reports (daily/weekly/monthly) | ❌ | — | **NOT IMPLEMENTED** |
| Payment UI stub in OrderDetailDrawer | ⚠️ | `OrderDetailDrawer.tsx` | Form exists but button is a no-op |

**Verdict:** Entire payment module missing. Only a UI stub exists.

---

### 8. PRODUCT CATALOG & INVENTORY

| Requirement | Status | File(s) | Notes |
|-------------|--------|---------|-------|
| Product CRUD API | ❌ | — | **NOT IMPLEMENTED** |
| Catalog fuzzy matching | ✅ | `item-extractor.ts` | Used in order creation |
| Stock deduction on CONFIRMED | ❌ | — | **NOT IMPLEMENTED** |
| Reorder alert | ❌ | — | **NOT IMPLEMENTED** |
| Manual stock adjustment | ❌ | — | **NOT IMPLEMENTED** |
| Catalog import (CSV) | ❌ | — | **NOT IMPLEMENTED** |
| Product selector in ManualOrderModal | ⚠️ | `ManualOrderModal.tsx` | Hardcoded mock product list only |

**Verdict:** Product catalog data model exists in Prisma but no service/routes/UI.

---

### 9. CUSTOMER RECORDS

| Requirement | Status | File(s) | Notes |
|-------------|--------|---------|-------|
| Auto-creation on first message | ✅ | `message-processor.worker.ts` | Customer upsert by waNumber |
| Customer profile fields | ⚠️ | `orders.repository.ts` | WaNumber, name stored; totalSpend, balance not calculated |
| Customer list view | ❌ | — | Not implemented |
| Customer search | ❌ | — | Not implemented |
| Customer tags (VIP, Wholesale, Blacklist) | ❌ | — | Not implemented |
| Outstanding balance calculation | ❌ | — | **NOT IMPLEMENTED** |
| Export to CSV | ❌ | — | Not implemented |

**Verdict:** Basic auto-creation works. Customer dashboard and balance logic missing.

---

### 10. AUTO-REPLY SYSTEM

| Requirement | Status | File(s) | Notes |
|-------------|--------|---------|-------|
| Order confirmation auto-reply | ✅ | `orders.service.ts` | Static template sent via WhatsApp |
| Status change notifications | ✅ | `orders.service.ts` | Sent on every transition |
| Template customization | ❌ | — | Not implemented |
| Template variables ({name}, {ref}, etc.) | ⚠️ | `orders.service.ts` | Static messages, no variable substitution |
| 24-hour conversation window check | ❌ | — | Not implemented |
| Status check auto-response | ❌ | — | Not implemented |

**Verdict:** Basic auto-reply works. Templates are static strings, not customizable.

---

### 11. STAFF MANAGEMENT

| Requirement | Status | File(s) | Notes |
|-------------|--------|---------|-------|
| Staff invitation | ❌ | — | Not implemented |
| Staff roles (Manager, Operations, Delivery) | ❌ | — | Not implemented |
| Staff dashboard filtering | ❌ | — | Not implemented |
| Activity log | ❌ | — | Not implemented |
| Staff deactivation | ❌ | — | Not implemented |

**Verdict:** Not implemented.

---

### 12. BILLING & PLANS

| Requirement | Status | File(s) | Notes |
|-------------|--------|---------|-------|
| Paystack customer creation | ✅ | `auth.service.ts` | Created on business registration |
| 14-day trial | ✅ | `auth.service.ts` | `trialEndsAt` set to 14 days |
| Plan enforcement middleware | ✅ | `business-context.middleware.ts` | Returns 402 for expired trials |
| Subscription management | ❌ | — | Not implemented |
| Paystack webhooks | ❌ | — | Not implemented |
| Billing page | ❌ | — | Not implemented |
| Upgrade flow | ❌ | — | Not implemented |
| Usage limits (conversations, orders, staff) | ❌ | — | Not implemented |

**Verdict:** Basic trial + customer creation works. Full billing lifecycle missing.

---

## Files Inventory

### API (`apps/api/src`)

**Implemented (37 files):**
- Foundation: `app.ts`, `server.ts`, `config/*` (database, env, logger, redis)
- Auth: `modules/auth/*` (4 files), `middleware/auth.middleware.ts`, `middleware/business-context.middleware.ts`
- Orders: `modules/orders/*` (4 files), `utils/item-extractor.ts`, `utils/order-reference.ts`
- Webhook: `modules/webhook/*` (3 files), `queues/message.queue.ts`, `workers/message-processor.worker.ts`
- Intent: `services/intent/*` (4 files)
- SSE: `services/sse/*` (3 files), `modules/sse/sse.route.ts`
- Shared: `utils/errors.ts`, `utils/response.ts`, `types/fastify.d.ts`, `services/whatsapp/outbound.ts`

**Missing modules:**
- `modules/payments/*` — Payment logging, screenshot review, receipt sending
- `modules/products/*` — Product CRUD, stock management, reorder alerts
- `modules/customers/*` — Customer list, profile, balance calculation
- `modules/staff/*` — Staff invitation, role management, activity log
- `modules/messages/*` — Message review queue, classification correction
- `modules/settings/*` — Template editor, business profile, billing settings

### Web (`apps/web/src`)

**Implemented (23 files):**
- Shell: `App.tsx`, `main.tsx`, `styles/globals.css`
- Layout: `components/shared/*` (5 files)
- UI primitives: `components/ui/*` (2 files)
- Orders: `components/orders/*` (4 files), `pages/Orders.tsx`
- Hooks: `hooks/*` (3 files)
- Types/Utils: `types/order.ts`, `lib/utils.ts`, `lib/events.ts`, `config/navigation.ts`

**Missing pages/components:**
- `pages/Login.tsx` — Authentication UI
- `pages/Dashboard.tsx` — Home with stats, live feed, alerts
- `pages/Customers.tsx`, `pages/CustomerProfile.tsx`
- `pages/Products.tsx`
- `pages/Payments.tsx`
- `pages/Messages.tsx`
- `pages/Staff.tsx`
- `pages/Settings.tsx`

---

## Critical Gaps (P0 Blockers)

1. **Payment Module** — No API endpoints for logging payments. Customer balances cannot be calculated. Revenue reports impossible.
2. **Product Catalog** — No CRUD API. Stock cannot be tracked or deducted. Reorder alerts impossible.
3. **Customer Dashboard** — No customer list page. Outstanding balances not calculated.
4. **Login Page** — Auth system exists but no frontend login flow.
5. **Stock Deduction** — Order confirmation does not touch inventory (acceptance criteria from Phase 3).

## Recommended Next Steps

1. **Payment module** — Build `payments.route.ts`, `payments.service.ts`, `payments.repository.ts` with manual logging, balance recalculation, and receipt auto-send.
2. **Product catalog** — Build `products.route.ts`, `products.service.ts` with CRUD + stock management. Wire stock deduction into `confirmOrder`.
3. **Customer module** — Build `customers.route.ts` with list, profile, balance calculation, and search.
4. **Login page** — Build `pages/Login.tsx` with OTP flow.
5. **Dashboard home** — Build `pages/Dashboard.tsx` with today's stats, live order feed, messages requiring review, stock alerts.
