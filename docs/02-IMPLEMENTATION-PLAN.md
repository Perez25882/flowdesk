# FLOWDESK — IMPLEMENTATION PLAN
**Version:** 1.0  
**Build approach:** AI-assisted, world-class output standard  

---

## PHASE 0 — Foundation (Days 1–2)
**Goal:** A running monorepo where every tool works before a single feature is written.

### Tasks

| # | Task | Done When |
|---|------|-----------|
| 0.1 | Initialize pnpm monorepo with Turborepo | `pnpm dev` starts without error |
| 0.2 | Set up apps/api (Fastify 4 + TypeScript) | Fastify server starts on port 3001 |
| 0.3 | Set up apps/web (Vite + React 18 + TypeScript + Tailwind + shadcn) | React app starts on port 5173 |
| 0.4 | Set up packages/shared (types shared between apps) | Both apps can import from it |
| 0.5 | Docker Compose for local Postgres + Redis | `docker-compose up -d` starts both |
| 0.6 | Prisma init + schema created + first migration runs | Tables exist in local DB |
| 0.7 | Environment variable validation with Zod in both apps | Missing var = descriptive error, not crash |
| 0.8 | Pino logger configured | Logs appear in dev with pretty print |
| 0.9 | GitHub repo + CI workflow | Lint + typecheck runs on every push |
| 0.10 | PM2 ecosystem file for production | `pm2 start ecosystem.config.js` works |

### Phase 0 Complete When
```
✓ pnpm dev → both apps running
✓ tsc --noEmit → zero errors
✓ eslint → zero warnings
✓ docker-compose up → postgres + redis healthy
✓ prisma migrate dev → migrations run clean
✓ GET /health → { status: "ok", db: "connected", redis: "connected" }
```

---

## PHASE 1 — Webhook Foundation (Days 3–6)
**Goal:** Receive, validate, store, and queue every incoming WhatsApp message. Zero message loss.

### Tasks

| # | Task | Done When |
|---|------|-----------|
| 1.1 | Meta webhook verification endpoint (GET /webhook) | Meta verification handshake passes |
| 1.2 | Meta webhook receiver endpoint (POST /webhook) | Returns 200 in < 1 second |
| 1.3 | HMAC-SHA256 signature validation | Invalid signature returns 401 |
| 1.4 | Raw message stored to DB before any processing | Message row exists even if worker fails |
| 1.5 | BullMQ message queue setup | Job appears in queue after webhook receipt |
| 1.6 | Message processor worker scaffold | Worker picks up job and logs it |
| 1.7 | Customer auto-creation on first message | Customer row created from sender number |
| 1.8 | Webhook test suite | Tests pass with real Meta payload fixtures |
| 1.9 | Duplicate message handling (idempotency on waMessageId) | Re-delivered message not processed twice |
| 1.10 | Dead letter queue for failed jobs | Failed jobs after 3 retries go to DLQ |

### Phase 1 Complete When
```
✓ Real WhatsApp message arrives
✓ Stored in messages table within 2 seconds
✓ Job appears in BullMQ within 2 seconds
✓ Customer row created or updated
✓ Load test: 1000 messages in 60 seconds → zero lost
```

---

## PHASE 2 — Intent Engine (Days 7–10)
**Goal:** Every text message gets classified accurately. No wrong action ever triggers on a wrong classification.

### Tasks

| # | Task | Done When |
|---|------|-----------|
| 2.1 | Rule engine — keyword + pattern matching for all 7 intents | Classifies basic English messages |
| 2.2 | Ghanaian English + Pidgin + Twi patterns added | Test set of local messages passes |
| 2.3 | Confidence scoring system | Every result has 0.0–1.0 confidence |
| 2.4 | Ambiguity penalty (multiple matching intents) | Mixed messages get lower confidence |
| 2.5 | Claude Haiku API integration | Low-confidence messages classified by Haiku |
| 2.6 | Redis caching of Haiku results | Same message text → no repeat API call |
| 2.7 | Haiku timeout handling (3000ms) | Timeout → UNCLASSIFIED, not crash |
| 2.8 | Manual review flagging | Low-confidence messages appear in review queue |
| 2.9 | Correction endpoint | Owner corrects classification via API |
| 2.10 | Unit test suite (200+ test cases) | 90%+ accuracy across all intent types |

### Phase 2 Complete When
```
✓ Rule engine: 90%+ accuracy on English test set
✓ Rule engine: 80%+ accuracy on mixed-language test set
✓ Haiku fallback fires only when confidence < 0.75
✓ Haiku cache hit rate > 60% after 48 hours of real traffic
✓ Review queue surfaces all UNCLASSIFIED messages
```

---

## PHASE 3 — Order Pipeline (Days 11–16)
**Goal:** ORDER intents become tracked records with immediate customer confirmation.

### Tasks

| # | Task | Done When |
|---|------|-----------|
| 3.1 | Reference number generator (Redis INCR, FD-00001 format) | Each business gets sequential refs |
| 3.2 | Item extractor from raw message text | "3 bags of rice" → { qty: 3, desc: "bags of rice" } |
| 3.3 | Fuzzy product catalog matching | "malta" matches "Malta Drink 330ml" |
| 3.4 | Order creation service (transaction: order + items) | Order + items created atomically |
| 3.5 | Auto-reply trigger after order creation | Customer receives confirmation in < 5s |
| 3.6 | Order status machine | Status changes follow valid transitions only |
| 3.7 | Status change history logging | Every change stored with actor and timestamp |
| 3.8 | Customer notification on every status change | WhatsApp message sent on each transition |
| 3.9 | SSE event on every order event | Dashboard updates without refresh |
| 3.10 | Manual order creation endpoint | Walk-in customer orders captured |
| 3.11 | Order assignment to staff | Order appears in staff's queue |
| 3.12 | Stock deduction on CONFIRMED | Inventory reduces atomically |
| 3.13 | Orders API (CRUD + list with filters) | All endpoints tested |

### Phase 3 Complete When
```
✓ Customer sends "I want 3 bags of rice" on WhatsApp
✓ Order appears on dashboard within 3 seconds
✓ Customer receives "Order received, Ref: FD-00001" within 5 seconds
✓ Stock quantity deducts when owner confirms order
✓ Status change → customer gets WhatsApp notification within 3 seconds
```

---

## PHASE 4 — Authentication & Business Management (Days 17–20)
**Goal:** Secure auth. Business onboarding. Staff management. WhatsApp connection flow.

### Tasks

| # | Task | Done When |
|---|------|-----------|
| 4.1 | Business registration endpoint | New business created in DB |
| 4.2 | OTP login via SMS (Twilio) | Business owner logs in with phone + OTP |
| 4.3 | JWT access token (15min) + refresh token (30 days) | Tokens issued on login |
| 4.4 | Token rotation on refresh | Old refresh token invalidated |
| 4.5 | Auth middleware on all protected routes | Unauthenticated request → 401 |
| 4.6 | Business context middleware | businessId injected from token to every request |
| 4.7 | Staff invitation (phone + role) | Invite sent via WhatsApp |
| 4.8 | Staff invite acceptance + password set | Staff account activated |
| 4.9 | Staff login flow | Staff logs in with phone + password |
| 4.10 | Role-based access control middleware | Operations staff cannot access financials |
| 4.11 | WhatsApp number connection wizard | Owner connects their number in < 5 minutes |
| 4.12 | Session management + logout | All sessions invalidated on logout |

### Phase 4 Complete When
```
✓ Owner registers → logs in → connects WhatsApp number (under 5 minutes total)
✓ Owner invites staff → staff activates account → staff logs in
✓ Staff cannot access endpoints outside their role (tested at API level)
✓ Token refresh works → access continues seamlessly
✓ Logout invalidates all sessions
```

---

## PHASE 5 — Dashboard (Days 21–28)
**Goal:** Clean, fast, real-time dashboard that works on 3G. Every page functional.

### Tasks

| # | Task | Done When |
|---|------|-----------|
| 5.1 | Design system: CSS variables, typography, color tokens | Variables defined in globals.css |
| 5.2 | Layout: collapsible sidebar (desktop), bottom nav (mobile) | Nav works on both breakpoints |
| 5.3 | SSE singleton hook (useSSE) with auto-reconnect | One persistent connection per session |
| 5.4 | Login page | Owner can authenticate |
| 5.5 | Onboarding / WhatsApp connection wizard | Guided setup flow |
| 5.6 | Dashboard home page | Stats, pending orders, alerts visible |
| 5.7 | Orders page — Kanban board | 4 columns, drag-to-move (dnd-kit) |
| 5.8 | Order detail drawer | Full order info, status actions, payment log |
| 5.9 | Manual order creation modal | Walk-in orders captured from dashboard |
| 5.10 | Customers page | Searchable list, balance highlights |
| 5.11 | Customer profile page | Full order + payment history |
| 5.12 | Products page | Catalog CRUD + stock management |
| 5.13 | Payments page | Payment log + screenshot review queue |
| 5.14 | Messages page | All inbound messages + review queue |
| 5.15 | Staff page | Invite, view, deactivate staff |
| 5.16 | Settings page | Template editor, billing, connection status |
| 5.17 | Skeleton loaders on all data-dependent components | No blank screens during loading |
| 5.18 | Error states on all data-dependent components | No unhandled API errors |
| 5.19 | Empty states on all lists and boards | Helpful empty state with CTA |
| 5.20 | Performance test on 3G throttling | Dashboard loads in < 4 seconds |

### Phase 5 Complete When
```
✓ All 8 pages navigable and functional
✓ Real-time: order created on WhatsApp → appears on Kanban without refresh
✓ Dashboard loads in < 4s on Chrome with 3G throttling
✓ All skeleton loaders visible during loading
✓ Works on Android Chrome at 375px width
```

---

## PHASE 6 — Payments & Inventory (Days 29–33)
**Goal:** Full payment tracking. Accurate inventory. Automated alerts.

### Tasks

| # | Task | Done When |
|---|------|-----------|
| 6.1 | Manual payment logging API | Payment stored, balance updated |
| 6.2 | Customer balance recalculation on every payment | Balance always accurate |
| 6.3 | MoMo screenshot detection (is-this-a-payment-screenshot heuristic) | Screenshots flagged correctly |
| 6.4 | Screenshot upload to S3 | File stored, URL saved to DB |
| 6.5 | Screenshot review queue UI | Owner sees flagged screenshots |
| 6.6 | Owner confirms screenshot → payment logged | One-tap confirmation flow |
| 6.7 | Payment receipt auto-sent to customer | Customer gets WhatsApp receipt |
| 6.8 | Stock deduction on order CONFIRMED (atomic) | Concurrent confirms don't over-deduct |
| 6.9 | Reorder alert via WhatsApp to owner | Alert sent when threshold crossed |
| 6.10 | Manual stock adjustment endpoint | Corrections and restocking logged |
| 6.11 | Revenue reports (daily/weekly/monthly) | Accurate aggregations |

### Phase 6 Complete When
```
✓ Full payment lifecycle: customer sends screenshot → owner confirms → receipt sent
✓ Two concurrent order confirmations for last unit → only one succeeds
✓ Owner receives WhatsApp alert when any product crosses reorder threshold
✓ Revenue figures match manual count of confirmed payments
```

---

## PHASE 7 — Hardening (Days 34–38)
**Goal:** Production-ready. Load tested. No edge case brings it down.

### Tasks

| # | Task | Done When |
|---|------|-----------|
| 7.1 | Rate limiting (Fastify plugin + Cloudflare rules) | 100 req/min per IP enforced |
| 7.2 | Request logging (Pino — method, path, duration, status) | Every request logged in production |
| 7.3 | Sentry error tracking integrated | All unhandled errors reported |
| 7.4 | Health check endpoint (`/health`) | Returns DB + Redis + queue status |
| 7.5 | Graceful shutdown (SIGTERM → drain queue → close connections) | Zero data loss on deploy |
| 7.6 | BullMQ dead letter queue processing endpoint | Admin can retry failed jobs |
| 7.7 | Webhook retry deduplication | Meta retry for same message not double-processed |
| 7.8 | Load test (k6): 1000 concurrent messages | All messages stored, zero 5xx |
| 7.9 | Security audit checklist | No exposed secrets, CORS locked, all routes auth'd |
| 7.10 | 48-hour staging run with real traffic | Zero unhandled errors in Sentry |

---

## PHASE 8 — Billing (Days 39–41)
**Goal:** Revenue flowing. Plans enforced.

### Tasks

| # | Task | Done When |
|---|------|-----------|
| 8.1 | Paystack plan creation (Starter, Business, Growth) | Plans exist in Paystack dashboard |
| 8.2 | Subscription creation on business registration | Business linked to Paystack subscription |
| 8.3 | Paystack webhook (payment success, failure, cancellation) | Events processed correctly |
| 8.4 | Trial period logic (14 days, then payment required) | Trial expiry blocks WhatsApp connection |
| 8.5 | Plan enforcement middleware (conversation limits, feature gates) | Starter can't exceed 500 convos |
| 8.6 | Billing page in dashboard (plan, usage, upgrade) | Business owner can see their plan |
| 8.7 | Upgrade flow (Starter → Business) | Plan change takes effect immediately |

---

## DEPENDENCIES AND RISKS

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Meta API verification delays | Medium | High | Start Meta Business verification in Week 1 |
| WhatsApp 24hr message window restrictions | High | Medium | Design templates for re-engagement |
| Ghanaian phone number format edge cases | High | Low | Comprehensive normalization + test suite |
| Haiku API latency on peak hours | Low | Medium | Redis caching reduces repeat calls |
| SME churn (price sensitivity) | Medium | High | 14-day trial + simple onboarding (< 10 minutes) |
| MoMo API access (for auto-reconciliation) | High | Low | Semi-auto (screenshot review) for MVP |

---

## DEFINITION OF DONE (GLOBAL)

A feature is shipped when:
- [ ] TypeScript compiles with zero errors
- [ ] ESLint passes with zero warnings
- [ ] Unit tests written and passing
- [ ] Integration test for every new API endpoint
- [ ] Loading state implemented (frontend)
- [ ] Error state implemented (frontend)
- [ ] Empty state implemented (lists/boards)
- [ ] Mobile layout tested at 375px
- [ ] No `console.log` in committed code
- [ ] No `any` TypeScript types
- [ ] No TODOs in committed code
- [ ] `.env.example` updated if new env vars added
