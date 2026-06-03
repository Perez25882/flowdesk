# Flowdesk — Product Requirements Document
**Version:** 1.0  
**Status:** Active  
**Last Updated:** 2025  

---

## 1. Product Overview

### What We're Building
Flowdesk is a WhatsApp operations layer for Ghanaian SMEs. It captures every WhatsApp conversation a business receives and converts it into structured, trackable business operations — orders, payments, customer records, and inventory — without changing how the business owner or their customers communicate.

### The Problem
Ghanaian SMEs run their entire business through WhatsApp. Orders, payments, supplier communication, customer service — all of it lives in chat threads. By end of day the business owner has processed hundreds of messages and recorded nothing. No order history. No customer database. No revenue figure. They are running a real business from memory and chat scroll.

The result:
- Orders get lost in chat
- Customers who paid get told they haven't
- Customers who didn't pay get their order anyway
- Stock runs out without warning
- Business owner cannot step away without operations collapsing
- No data to make business decisions

### Core Value Proposition
Every WhatsApp message your business receives becomes a tracked, actionable business record — automatically.

### What We Are Not Building
- A replacement for WhatsApp (customers keep using WhatsApp exactly as before)
- An e-commerce storefront
- A general CRM
- An accounting platform
- A delivery tracking system

---

## 2. Users

### 2.1 Business Owner
**Who they are:** Runs a shop, distribution business, food vendor, fashion brand, or pharmacy. Has 1–10 staff. Receives 50–300 WhatsApp messages daily. Non-technical.

**Primary device:** Mobile phone (Android dominant in Ghana)

**Pain they feel daily:**
- "I can't remember if this customer already paid"
- "I missed an order because it was buried in chat"
- "I don't know how much money came in today"
- "When I'm not on my phone, nothing gets done"

**What they need from Flowdesk:**
- Zero missed orders
- Know exactly what every customer owes at any moment
- See the day's revenue without calculating it manually
- Trust that their staff is handling things correctly while they're busy

---

### 2.2 Staff Member
**Who they are:** Assigned to handle packing, delivery, or payment logging. Uses the business owner's system. Not the decision-maker.

**Primary device:** Mobile phone

**What they need from Flowdesk:**
- See only what is relevant to their role
- Know what tasks are assigned to them
- Mark orders as done without touching financial data

---

### 2.3 End Customer
**Who they are:** Sends orders to the business via WhatsApp. Could be a retail buyer, a wholesale buyer, or a regular individual customer.

**What they need from Flowdesk:**
- Instant confirmation that their order was received
- A reference number they can quote
- Status updates when their order moves
- Payment receipt when they pay

**What they must never have to do:**
- Download an app
- Create an account
- Change how they message the business

---

## 3. User Stories

### Business Owner Stories

| ID | Story | Priority |
|----|-------|----------|
| O-001 | As an owner, I want every WhatsApp order automatically captured so I never lose an order in chat | P0 |
| O-002 | As an owner, I want to see all pending orders in one view so I know what needs fulfillment | P0 |
| O-003 | As an owner, I want to know which customers owe me money and exactly how much | P0 |
| O-004 | As an owner, I want customers to receive automatic order confirmations so I don't manually reply every time | P0 |
| O-005 | As an owner, I want to see today's revenue, this week's, and this month's without calculating it | P0 |
| O-006 | As an owner, I want to be alerted when a product is running low before I run out | P0 |
| O-007 | As an owner, I want to add staff so they can update order statuses without seeing financials | P1 |
| O-008 | As an owner, I want to create orders manually for walk-in or phone customers | P1 |
| O-009 | As an owner, I want to see all messages that the system wasn't sure how to handle | P1 |
| O-010 | As an owner, I want to correct a misclassified message so the system learns | P2 |
| O-011 | As an owner, I want to export my customer list to CSV | P2 |
| O-012 | As an owner, I want to customize the automatic reply templates | P2 |
| O-013 | As an owner, I want to see which products sell the most | P2 |
| O-014 | As an owner, I want to send a broadcast message to a customer segment | P3 |

### Staff Stories

| ID | Story | Priority |
|----|-------|----------|
| S-001 | As a staff member, I want to see orders assigned to me | P0 |
| S-002 | As a staff member, I want to mark an order as packed or delivered | P0 |
| S-003 | As a staff member, I want to log a cash payment when a customer pays in person | P1 |

### Customer Stories

| ID | Story | Priority |
|----|-------|----------|
| C-001 | As a customer, I want an instant confirmation when I place a WhatsApp order | P0 |
| C-002 | As a customer, I want a reference number I can use to follow up | P0 |
| C-003 | As a customer, I want to check my order status by sending a WhatsApp message | P1 |
| C-004 | As a customer, I want a payment receipt after I pay | P1 |

---

## 4. Feature Requirements

### 4.1 Core Features (MVP)

#### F-001: WhatsApp Number Registration
Business owner connects their WhatsApp Business number to Flowdesk. The system verifies the connection and begins intercepting messages.

**Acceptance Criteria:**
- Owner can connect a number in under 5 minutes via a guided wizard
- One phone number can only be connected to one Flowdesk account
- Owner can disconnect at any time and retain all historical data
- Zero messages are dropped during connection setup
- System handles Meta Business verification flow inline

---

#### F-002: Message Ingestion Pipeline
Every incoming WhatsApp message is captured, stored, and queued for processing in real time.

**Acceptance Criteria:**
- Message stored to database within 2 seconds of receipt
- Zero message loss even if downstream processing fails
- Queue-based architecture decouples receipt from processing
- Retry logic handles processing failures automatically
- Handles: text, images, audio (flagged for review), documents (logged, not parsed)
- Duplicate messages detected and ignored (idempotent on waMessageId)

---

#### F-003: Intent Detection Engine
Every text message is automatically classified into one of: ORDER, PAYMENT, INQUIRY, STATUS_CHECK, COMPLAINT, GREETING, OTHER, UNCLASSIFIED.

**Acceptance Criteria:**
- Classification happens within 2 seconds of message receipt
- Rule-based engine handles 80%+ of cases with ≥0.75 confidence
- Claude Haiku used as fallback for confidence below 0.75
- Haiku fallback responds in under 3 seconds, times out gracefully
- Low-confidence messages flagged for owner review
- Owner can correct a misclassification from the dashboard
- Must handle: Standard English, Ghanaian English, Pidgin, Twi-English mix
- Target accuracy: 90%+ on representative sample of 200 messages

---

#### F-004: Order Management
Detected ORDER messages automatically become tracked order records.

**Order Statuses:** `PENDING → CONFIRMED → PROCESSING → FULFILLED` (or `CANCELLED` at any stage)

**Acceptance Criteria:**
- Order record created automatically from detected ORDER message
- Unique reference number generated (format: FD-00001, per-business atomic counter)
- Customer auto-reply sent with confirmation and reference number
- Order appears on owner dashboard within 3 seconds of customer message
- Items extracted from message text on a best-effort basis (never blocks order creation)
- Items matched to product catalog using fuzzy matching
- Unmatched items flagged, not blocked
- Status changes trigger customer WhatsApp notification
- Status changes trigger real-time dashboard update
- Full status history stored for every order
- Owner can create orders manually from dashboard (walk-in customers)
- Owner can edit parsed order details
- Owner can assign orders to staff members
- Bulk status update supported

---

#### F-005: Customer Records
Every unique WhatsApp number that interacts with the business gets an auto-created customer profile.

**Acceptance Criteria:**
- Customer profile created on first message, no manual entry required
- Profile contains: number, name (from WA profile or manual), all orders, total spend, outstanding balance, last interaction, tags
- Tags: VIP, Wholesale, Blacklist, custom
- Blacklisted customers flagged on all inbound messages
- Customer search by name or phone number
- Customer list export to CSV
- No duplicate profiles for same number

---

#### F-006: Payment Logging
Track payments against orders and customer balances.

**Manual Mode (MVP):**
Owner or staff logs payment — amount, method (MoMo MTN/Vodafone/AirtelTigo, Cash, Bank Transfer), reference if available.

**Screenshot Review Mode (MVP):**
Customer sends MoMo screenshot → System detects it as a potential payment → Flags on dashboard → Owner confirms amount and links to order with one tap → Receipt auto-sent to customer.

**Acceptance Criteria:**
- Payment linked to specific order or customer running balance
- Outstanding balance tracked per customer in real time
- Daily, weekly, monthly revenue summary accurate
- Overpayment and underpayment both handled
- Payment receipt sent to customer on confirmation
- MoMo screenshot detection works across MTN, Vodafone, AirtelTigo formats

---

#### F-007: Product Catalog
Owner defines their products. System uses the catalog for order item matching and inventory tracking.

**Acceptance Criteria:**
- Product has: name, unit, price, stock quantity, reorder threshold, aliases (alternate names), SKU (optional)
- Aliases used during fuzzy matching (e.g. "Malta Guinness" and "Malta" both match)
- Stock quantity deducts automatically when order is CONFIRMED
- Low stock alert sent to owner via WhatsApp when quantity hits reorder threshold
- Catalog import via CSV
- Product can be deactivated (not deleted) when discontinued

---

#### F-008: Staff Management
Owner invites and manages staff with role-based access.

**Roles:**
- **Manager:** Everything except billing
- **Operations:** Orders and inventory, no financials
- **Delivery:** Only orders assigned to them

**Acceptance Criteria:**
- Owner invites staff via phone number (WhatsApp invite link sent)
- Staff login via phone + OTP
- Staff activity logged
- Owner can revoke access instantly
- Role permissions enforced server-side, not just frontend

---

#### F-009: Real-Time Dashboard
Single-page dashboard that updates in real time as events happen.

**Acceptance Criteria:**
- Loads in under 4 seconds on a 3G connection
- New orders appear without page refresh (SSE)
- Dashboard shows: today's orders (count + value), pending orders, flagged messages, revenue (day/week/month), low stock alerts, outstanding payment alerts
- Works on 375px mobile viewport without horizontal scroll
- All data visible without zooming
- Reconnects automatically if SSE connection drops

---

#### F-010: Automated Reply Templates
Pre-built response templates fire automatically on detected intents.

| Trigger | Template |
|---------|----------|
| Order detected | "Hi {name}! We've received your order (Ref: {ref}). We'll confirm shortly." |
| Order confirmed | "Your order {ref} is confirmed and being prepared." |
| Order fulfilled | "Your order {ref} has been sent. Thank you for your business!" |
| Status check | "Your order {ref} is currently: {status}" |
| Payment received | "Payment of GHS {amount} received. Thank you!" |

**Acceptance Criteria:**
- Owner can customize all templates
- Variables: `{name}`, `{ref}`, `{amount}`, `{product}`, `{status}`, `{business_name}`
- Owner can disable any auto-reply
- Templates stored per business, not globally
- English default. Twi option in V2.

---

### 4.2 V2 Features (Post-MVP, Documented for Architecture Awareness)

- **OCR Payment Confirmation:** Fully automated MoMo screenshot reading (Google Vision API)
- **Broadcast Messaging:** Send promotions to tagged customer segments
- **Supplier Management:** Send restocking orders via WhatsApp
- **Multi-location Support:** One account, multiple shop locations
- **Twi Language Parsing:** Native Twi intent classification
- **Analytics Dashboard:** Best sellers, peak hours, repeat customer rate, cohort retention
- **QuickBooks/Wave Integration:** Export for accountants
- **Android App:** Native mobile app (web app is mobile-first but not native)
- **Delivery Tracking:** Assign and track delivery agents per order

---

## 5. Non-Functional Requirements

### Performance
| Metric | Requirement |
|--------|-------------|
| Message ingestion to dashboard display | < 3 seconds |
| Dashboard initial load (3G) | < 4 seconds |
| API response time (p95) | < 500ms |
| Intent classification (rule engine) | < 200ms |
| Intent classification (Haiku fallback) | < 3 seconds |
| Concurrent business accounts at launch | 10,000 |

### Reliability
| Metric | Requirement |
|--------|-------------|
| Uptime | 99.5% (WhatsApp outages excluded) |
| Message loss | Zero — every message stored before processing begins |
| Data backup | Daily automated, 30-day retention |
| Queue failure recovery | Automatic retry with exponential backoff |

### Security
| Requirement | Detail |
|-------------|--------|
| Data at rest | AES-256 encryption |
| Data in transit | TLS 1.3 |
| WhatsApp tokens | Stored in secrets manager, never in codebase |
| Webhook validation | HMAC-SHA256 with timing-safe comparison |
| Auth tokens | JWT with 15min expiry + 30-day refresh rotation |
| Staff access | Server-side role enforcement, not frontend only |
| Rate limiting | Cloudflare layer + application layer |
| GDPR-adjacent | Customer can request data deletion |

### Scalability
| Requirement | Detail |
|-------------|--------|
| Message queue | Handles burst traffic (market days, salary periods, promos) |
| Application layer | Stateless — horizontally scalable from day one |
| Database | Connection pooling, read replicas in Phase 2 |
| Architecture | Designed for 10x growth without structural change |

---

## 6. Constraints and Assumptions

### Constraints
- Must work reliably on 3G connections (Ghana's default for most SME owners)
- Must work on Android phones from 2019 onwards (low-end hardware)
- WhatsApp Business API: free-form messages only within 24hr window; templates required outside that window
- Meta conversation pricing: ~$0.04–0.06 per 24hr window after free tier (1000/month)

### Assumptions
- Business owners have a WhatsApp Business account (not personal)
- Customers are in Ghana or messaging from numbers that WhatsApp recognizes
- Ghanaian phone numbers follow the 0XX-XXX-XXXX format (10 digits, starting with 0)
- MoMo is the dominant payment method for the target businesses

---

## 7. Out of Scope (MVP)

- iOS-specific features (Android first)
- Offline mode
- Multi-language UI (English only in MVP)
- Automatic tax calculation
- Integration with physical POS systems
- Customer-facing web portal
- Automated delivery scheduling
