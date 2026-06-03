# Flowdesk — Product Requirements Document
**Version:** 2.0 | **Status:** Active | **Owner:** Product

---

# PART 1: PRODUCT FOUNDATION

## 1.1 Problem Statement

There are approximately 3.1 million small and medium businesses operating in Ghana. The overwhelming majority conduct their business through WhatsApp. Orders come through WhatsApp. Payment confirmations come through WhatsApp. Supplier communication happens on WhatsApp. Customer service happens on WhatsApp.

The result is that a thriving business's entire operational record lives inside a chat application that has no search, no structure, no data export, no analytics, and no access controls. When a business owner has 300 unread messages at 6am, they are not running a business. They are managing a chat thread.

This creates five compounding failures:

**Failure 1: Lost Orders**
Messages get buried. A customer sends an order at 11pm. By morning, 80 new messages sit above it. The owner scrolls, misses it, the customer follows up angrily. The order is either fulfilled late or lost entirely.

**Failure 2: Payment Disputes**
A customer sends a MoMo screenshot. Three days later the owner cannot find it. The customer claims they paid. The owner has no record. Trust breaks down. The business loses either the money or the customer.

**Failure 3: Zero Business Intelligence**
At end of month, the owner cannot answer: How much did I make? Which product sold the most? Who are my best customers? What days are busiest? They run the business on instinct because data does not exist.

**Failure 4: Owner Dependency**
The business cannot operate without the owner on their phone. A sick day, a funeral, a trip — and operations collapse. There is no way to give staff access to what they need without giving them access to everything.

**Failure 5: No Growth Foundation**
Banks won't lend without financial records. Investors won't invest without data. Larger buyers won't partner without professional systems. The business cannot grow beyond what one person can hold in their head.

---

## 1.2 Solution

Flowdesk is a WhatsApp operations layer. It connects to a business's WhatsApp Business number and silently captures every incoming message, converts it into structured data, and surfaces that data through a clean real-time dashboard.

The customer changes nothing. The business owner changes nothing about how they talk to customers. The magic happens behind the number.

A customer sends "I want 3 bags of rice" — and an order appears on the owner's dashboard before they even open WhatsApp. The customer receives a professional confirmation with a reference number. The inventory deducts. The record exists forever.

---

## 1.3 Vision

**Year 1:** Every Ghanaian SME that runs on WhatsApp runs better because of Flowdesk.

**Year 3:** Flowdesk is the operational backbone of Ghanaian commerce — the data layer that enables SME lending, insurance, supplier credit, and market access.

**Year 5:** Expand across West Africa. The same WhatsApp-first commerce pattern exists in Nigeria, Ivory Coast, Senegal, and beyond.

---

## 1.4 Positioning

| | Flowdesk | Tonaton Listings | Generic CRM | ERP Systems |
|--|---------|-----------------|-------------|-------------|
| Works on WhatsApp | ✓ | ✗ | ✗ | ✗ |
| No behavior change for customers | ✓ | ✗ | ✗ | ✗ |
| Real-time | ✓ | ✗ | Partial | Partial |
| Built for Ghana | ✓ | ✓ | ✗ | ✗ |
| SME pricing | ✓ | ✓ | Varies | ✗ |
| MoMo payment tracking | ✓ | ✗ | ✗ | ✗ |
| Works on 3G | ✓ | Partial | ✗ | ✗ |

**Competitive moat:** Flowdesk is the only product that sits on the actual WhatsApp conversation and converts it into structured operations. Every competitor requires the business owner to change behavior. Flowdesk does not.

---

# PART 2: USERS

## 2.1 Primary Persona — The Owner

**Name:** Abena  
**Business:** Grocery distributor, Kumasi Central Market  
**Staff:** 4 people  
**Daily WhatsApp messages:** 150–200  
**Phone:** Samsung Galaxy A32 (Android)  
**Connection:** MTN Ghana, 3G mostly  
**Pain:** "By the time I finish reading my messages I've forgotten what was in the first ones."

**Jobs to be done:**
- Know immediately when a new order arrives without reading every message
- Know at any moment what each customer owes
- Know at end of day how much came in without adding it up manually
- Trust that staff is doing the right thing when she's not watching

**Willingness to pay:** GHS 150–350/month. Considers it reasonable if it saves one hour per day and prevents one dispute per week.

**Adoption barrier:** "I've tried apps before and they didn't stick." Needs to see value within 48 hours or she won't log in again.

**Success metric:** She checks the dashboard instead of WhatsApp first thing in the morning.

---

## 2.2 Secondary Persona — The Staff Member

**Name:** Kofi  
**Role:** Operations at Abena's distributor  
**Responsibilities:** Packs orders, logs deliveries, handles customer pickups  
**Pain:** "Madam gives me messages to handle but I miss some because I don't have her phone."

**Jobs to be done:**
- See which orders are assigned to him without accessing personal chats
- Mark an order as packed or delivered without financial access
- Know when a customer is coming for pickup

**Willingness to pay:** Does not pay — access granted by owner.

**Success metric:** Kofi completes his assigned orders every day without calling the owner.

---

## 2.3 Tertiary Persona — The Customer

**Name:** Emmanuel  
**Business:** Restaurant owner buying wholesale from Abena  
**Pain:** "Sometimes I'm not sure if my order went through. I have to call to check."

**Jobs to be done:**
- Know immediately that his order was received
- Be able to reference his order when it arrives
- Receive a receipt when he pays

**What he must NOT have to do:**
- Download any app
- Create any account
- Change how he messages Abena

**Success metric:** He mentions to a friend "Abena's system is very professional now."

---

## 2.4 User Journeys

### Journey 1: First Order (New Business Owner)

```
Day 1, 11:32am — Abena signs up, enters business name and phone
Day 1, 11:35am — Receives WhatsApp OTP, verifies, enters dashboard
Day 1, 11:37am — Connects WhatsApp Business number (guided 4-step wizard)
Day 1, 11:40am — Adds 5 products to catalog (rice 50kg, rice 25kg, oil, malta, water)
Day 1, 11:45am — Tells a customer "message me on WhatsApp as usual"
Day 1, 11:46am — Customer sends "I want 2 bags of rice 50kg"
Day 1, 11:46am — Abena's dashboard shows a new card: FD-00001
Day 1, 11:46am — Customer receives: "Hi Emmanuel! We received your order
                  (Ref: FD-00001). We'll confirm shortly. — Ama's Store"
Day 1, 11:47am — Abena stares at her phone and says "Ei."

OUTCOME: Value realized in 7 minutes from sign-up.
```

### Journey 2: Daily Operations (Established User)

```
6:30am — Abena opens Flowdesk. Dashboard shows:
          12 orders pending from yesterday afternoon
          3 messages flagged for her review
          Revenue yesterday: GHS 4,230
          Rice 50kg is at reorder threshold (8 bags)

6:35am — Confirms 10 orders (bulk confirm). 10 customers receive WhatsApp updates.
6:36am — Reviews 3 flagged messages. One is a complaint. She replies via WhatsApp.
6:40am — Tells Kofi: "Your orders are ready, check your dashboard."
10:00am — Customer sends MoMo screenshot. Dashboard flags it.
10:01am — Abena confirms GHS 450 payment, links to FD-00008.
10:01am — Emmanuel receives receipt: "Payment of GHS 450 received for FD-00008. Thank you."
5:00pm — Day ends. Revenue dashboard shows GHS 6,850 for the day.
          Abena knows this for the first time ever without calculating it herself.
```

---

# PART 3: FEATURE SPECIFICATIONS

## 3.1 FEATURE: Message Ingestion

### What it does
Every WhatsApp message sent to the business number is captured, stored, and processed.

### Detailed behavior

**Input types:**
| Message Type | Processing | Auto-Action |
|-------------|-----------|-------------|
| Text | Full intent classification pipeline | Based on intent |
| Image | Screenshot detection check | Flag if payment screenshot |
| Audio | Store, flag for review | Owner notification |
| Video | Store only | Log |
| Document | Store only | Owner notification |
| Sticker | Store only | None |
| Reaction | Store, link to original | None |
| Interactive button reply | Classify as text | Based on intent |

**Deduplication:**
Meta sometimes delivers the same webhook twice (network reliability). Flowdesk checks `waMessageId` against a Redis cache before processing. Duplicate → skip silently. Cache TTL: 24 hours.

**Message metadata stored:**
waMessageId, direction (INBOUND), type, body, mediaUrl, mediaType, senderNumber, businessId, customerId, timestamp (from Meta, not received time), processed status, intent, confidence, classifiedBy, requiresReview, relatedOrderId.

### Edge cases
- Empty body message: stored, intent = OTHER, no action
- Message too long (>4096 chars): store full content, classify on first 500 chars
- Non-Ghana number: process normally (diaspora customers are common)
- Business number messages itself: stored, flagged as internal, no auto-reply

---

## 3.2 FEATURE: Intent Classification

### What it does
Every text message is assigned an intent. The system acts on that intent. Getting this right is the core of the product.

### Intent Taxonomy

| Intent | Description | Action |
|--------|-------------|--------|
| ORDER | Customer wants to buy something | Create order record |
| PAYMENT | Customer is notifying of a payment | Flag for payment review |
| INQUIRY | Question about price, availability, hours | Flag for owner review |
| STATUS_CHECK | Asking about an existing order | Auto-reply with status |
| COMPLAINT | Problem with an order or product | Flag as complaint |
| GREETING | Hello, good morning, etc. | Optional courtesy reply |
| OTHER | Doesn't fit any category | Log only |
| UNCLASSIFIED | System could not determine | Flag for manual review |

### Classification Engine

**Stage 1 — Rule Engine (handles ~80% of messages)**
Pattern matching against curated keyword sets. Accounts for:
- Standard English
- Ghanaian English ("abeg", "chale", "ooo", "abi")
- Pidgin ("make I get", "e don reach", "I don pay")
- Twi-English mix ("mepɛ", "mesrɛ", "ɛnti")
- Common abbreviations ("pls", "plz", "wnt", "qty")
- Quantity patterns ("3", "three", "x3", "3bags", "3 bags")

Confidence threshold: 0.75. Below → Stage 2.

**Stage 2 — Claude Haiku (handles ~20% of messages)**
Lightweight LLM for ambiguous cases. 3-second timeout. Results cached 24 hours in Redis. Falls back gracefully to UNCLASSIFIED if unavailable.

**Manual override:**
Owner can correct any classification from the Messages page. Correction stored as MANUAL classification. Patterns of corrections logged for future rule engine improvements.

### Accuracy Target
90%+ on a representative corpus of 500 real Ghanaian SME messages (English, Pidgin, Twi-English mix). Validated before MVP launch.

---

## 3.3 FEATURE: Order Management

### What it does
Turns ORDER messages into tracked, actionable records with full lifecycle management.

### Order Creation
**Trigger:** Message classified as ORDER with confidence ≥ 0.75

**Auto-extraction (best-effort, never blocks order creation):**
- Quantity: "3", "three", "x3" → 3
- Product: fuzzy match against catalog (name + aliases, Levenshtein ≥ 0.75)
- If matched: unit price from catalog, subtotal calculated
- If unmatched: stored as free-text description, no price

**Always happens regardless of extraction success:**
- Unique reference number generated (FD-00001 format)
- Order record created with status PENDING
- Customer auto-reply sent with reference number
- Dashboard updated in real time (SSE)

### Order Lifecycle

```
                    PENDING
                      │
          ┌───────────┴────────────┐
          │                        │
       CONFIRMED              CANCELLED (with reason)
          │
          │
       PROCESSING
          │
          │
       FULFILLED
```

**Transitions:**
- PENDING → CONFIRMED: Owner/manager explicitly confirms
- PENDING → CANCELLED: Owner/manager cancels (reason required)
- CONFIRMED → PROCESSING: Order being prepared
- CONFIRMED → CANCELLED: Owner/manager cancels
- PROCESSING → FULFILLED: Order delivered/collected
- PROCESSING → CANCELLED: Edge case (refund scenario)
- FULFILLED → (none): Terminal state
- CANCELLED → (none): Terminal state

**On each transition:**
- Status history record created (immutable)
- Customer WhatsApp notification sent
- SSE event broadcast to all connected dashboards
- Audit log updated

### Manual Orders
For walk-in or phone customers not on WhatsApp:
- Owner creates order from dashboard
- Customer field: search existing or create new (name + phone)
- Items: select from catalog or add free-text
- No auto-reply (no WhatsApp number to reply to — or not appropriate)

### Order Reference System
Format: `FD-{5-digit-zero-padded-counter}`
Counter is per-business, atomic (Redis INCR), sequential.
Examples: FD-00001, FD-00099, FD-01000, FD-99999, FD-100000 (grows beyond 5 digits naturally)
Fallback (Redis unavailable): `FD-{base36-timestamp-8-chars}` (unique, not sequential)

### Order Fields

| Field | Type | Notes |
|-------|------|-------|
| referenceNumber | String | FD-XXXXX, unique globally |
| status | Enum | PENDING/CONFIRMED/PROCESSING/FULFILLED/CANCELLED |
| rawMessage | String | Original customer message, never modified |
| items | OrderItem[] | Extracted + matched items |
| totalAmount | Decimal | Sum of matched item subtotals (0 if none matched) |
| amountPaid | Decimal | Sum of verified payments linked to this order |
| notes | String? | Owner notes |
| assignedStaffId | String? | Staff member handling this order |
| fulfilledAt | DateTime? | When status → FULFILLED |
| cancelledAt | DateTime? | When status → CANCELLED |
| cancelReason | String? | Required on cancellation |

---

## 3.4 FEATURE: Customer Records

### What it does
Builds a customer database automatically from WhatsApp interactions. No data entry required.

### Auto-Creation
First message from any number → customer profile created instantly:
- waNumber: normalized Ghana format (233XXXXXXXXX)
- name: extracted from WhatsApp contacts array if available, null otherwise
- All other fields at defaults

Owner can enrich: add name, add tags, add notes.

### Customer Profile Fields

| Field | Source | Notes |
|-------|--------|-------|
| waNumber | WhatsApp | Primary identifier, normalized |
| name | WA profile or manual | Editable |
| totalSpend | Calculated | Sum of all verified payments |
| outstandingBalance | Calculated | Sum of order totals - sum of verified payments |
| orderCount | Calculated | Total lifetime orders |
| tags | Manual | VIP, Wholesale, Retail, Blacklist, custom |
| blacklisted | Manual | Flags all inbound messages |
| lastInteractionAt | Automatic | Updated on every inbound message |
| notes | Manual | Private owner notes |

### Outstanding Balance Calculation
```
outstandingBalance =
  SUM(order.totalAmount WHERE status IN [CONFIRMED, PROCESSING, FULFILLED])
  - SUM(payment.amount WHERE verified = true AND payment.customerId = customer.id)
```

Balance is recalculated on every payment verification and order status change. Never cached — always from source of truth.

### Customer Tags

**Built-in tags:**
- VIP: special treatment, shown prominently on order cards
- Wholesale: different pricing tier (informational — pricing not automated in MVP)
- Blacklist: flags all messages, suppresses auto-replies

**Custom tags:**
- Owner can create any tag
- Tags are searchable and filterable on customer list
- Can be used for broadcast segmentation (V2)

### Customer List View
Columns: Name, Phone, Orders, Total Spend, Balance, Last Active, Tags
Default sort: Last Active DESC
Search: by name (partial) or exact/partial phone number
Filter: by tag, by balance > 0, by date range
Export: full list as CSV (Business plan+)

---

## 3.5 FEATURE: Payment Tracking

### What it does
Tracks every payment against customers and orders. Surfaces who owes what. Confirms payment screenshots automatically.

### Payment Methods
- MoMo MTN
- MoMo Vodafone Cash
- MoMo AirtelTigo
- Cash
- Bank Transfer
- Other

### Manual Payment Logging
Owner or manager:
1. Opens customer or order record
2. Taps "Log Payment"
3. Enters: amount, method, reference (optional), notes (optional)
4. Links to specific order or logs as general balance payment
5. System updates customer outstanding balance
6. Optional: sends receipt to customer

### MoMo Screenshot Detection

**Trigger:** Customer sends an image

**Detection process:**
1. Retrieve image from Meta API (temporary URL, valid 5 minutes)
2. Store image to S3 immediately (before it expires)
3. Run screenshot classifier:
   - Check image dimensions (MoMo screenshots have consistent aspect ratios)
   - Check for MoMo visual patterns (color detection — MTN yellow, Vodafone red)
   - Check for payment-related text in surrounding message body
4. Confidence ≥ 0.7 → flag as potential payment screenshot

**Review flow:**
1. Dashboard notification: "Payment screenshot from [Customer Name]"
2. Owner opens review — sees screenshot, customer, message context
3. Owner confirms: enters amount, selects method, links to order (or general balance)
4. System logs payment as verified
5. Automatic receipt sent to customer

**Why not full OCR:**
OCR on MoMo screenshots is difficult due to variation in screenshot quality, cropping, different network UI designs, and Ghanaian phone screenshot habits. Manual confirmation (one tap) is faster and more reliable for MVP. Full OCR is V2.

### Payment Receipt
Sent automatically when a payment is verified:
"Payment of GHS 450.00 received for order FD-00008. Thank you for your business! — Ama's Store"

### Revenue Reports
- Today's total
- This week's total
- This month's total
- By payment method breakdown
- By product breakdown (for confirmed orders)
- Outstanding balance total (all customers)

---

## 3.6 FEATURE: Product Catalog

### What it does
Defines the business's products. Powers order item matching, inventory tracking, and pricing.

### Product Fields

| Field | Notes |
|-------|-------|
| name | Primary name (e.g., "Rice 50kg") |
| unit | Measurement unit (bag, carton, piece, kg, litre, etc.) |
| price | Selling price in GHS |
| stockQuantity | Current stock level |
| reorderThreshold | Stock level that triggers an alert |
| aliases | Alternate names (["rice", "50kg rice", "big rice"]) |
| sku | Optional internal code |
| active | Soft deactivation for discontinued products |

### Aliases
Critical for matching accuracy. Example:
- Product: "Malta Guinness 33cl" (GHS 5.50)
- Aliases: ["malta", "Malta", "malt", "Malta Guinness", "small malta"]
- Customer writes: "I want 24 malta" → matched to Malta Guinness 33cl

Aliases are case-insensitive in matching. Owner adds them manually (prompted during catalog setup).

### Fuzzy Matching
When a customer message contains an item name:
1. Exact match on name or aliases (case-insensitive) → matched
2. Levenshtein similarity ≥ 0.75 against name and aliases → matched
3. Below threshold → stored as unmatched description

Unmatched items: order still created, owner prompted to manually link item to product.

### Inventory Management
- Stock deducts when order moves to CONFIRMED (not PENDING — prevents premature deduction)
- Stock deduction is per-order-item, quantity × 1 (base unit)
- Negative stock allowed (owner may have stock the system doesn't know about)
- Manual stock adjustment: owner can add or subtract any amount with a reason note
- Reorder alert: when stockQuantity ≤ reorderThreshold after any deduction

### Catalog Import
Business plan and above: import products from CSV.
Required columns: name, unit, price
Optional: stockQuantity, reorderThreshold, aliases (comma-separated), sku

---

## 3.7 FEATURE: Auto-Reply System

### What it does
Sends automatic WhatsApp replies on key events, so the business owner doesn't have to manually respond to every message.

### Default Reply Templates

| Event | Default Template |
|-------|-----------------|
| Order detected (PENDING) | "Hi {name}! We received your order (Ref: {ref}). We'll confirm shortly. — {business}" |
| Order confirmed | "Your order {ref} is confirmed and being prepared. We'll let you know when it's ready. — {business}" |
| Order processing | "Your order {ref} is being packed and prepared for delivery/pickup. — {business}" |
| Order fulfilled | "Your order {ref} has been completed. Thank you for your business! — {business}" |
| Order cancelled | "Your order {ref} has been cancelled. {reason} Please contact us if you have questions. — {business}" |
| Payment received | "Payment of GHS {amount} received for order {ref}. Thank you! — {business}" |
| Status check response | "Your order {ref} is currently: {status}. {details} — {business}" |

### Template Variables

| Variable | Resolves To |
|----------|------------|
| {name} | Customer's first name, or "there" if not known |
| {ref} | Order reference number (FD-00234) |
| {business} | Business name |
| {amount} | Formatted amount (GHS 450.00) |
| {status} | Human-readable status |
| {details} | Status-specific details (e.g., "Assigned to Kofi for delivery") |
| {reason} | Cancellation reason |

### Customization
- Owner can edit any template text
- Templates support all variables via `{variable_name}` syntax
- Any auto-reply can be disabled individually
- Preview shows rendered template before saving

### Conversation Window Enforcement
- System checks `customer.lastInteractionAt` before sending
- Within 24 hours: send as free-form text
- Outside 24 hours: send via Meta-approved template (slightly different format)
- Template required for: stock alerts to owner, broadcast messages (V2)

### Status Check Auto-Response
When customer sends STATUS_CHECK (e.g., "What happened to FD-00234?"):
1. Extract reference number from message
2. If found: reply with current status and relevant details
3. If not found: reply "We couldn't find that order. Please check the reference number or contact us."

Auto-response to STATUS_CHECK: on by default. Owner can disable.

---

## 3.8 FEATURE: Staff Management

### What it does
Allows owner to extend operations to staff with scoped, role-based access.

### Roles

| Role | Can See | Can Do |
|------|---------|--------|
| Manager | Everything except billing | All operations, staff management, view financials |
| Operations | Orders, inventory, customers, messages | Update order status, log payments, manage catalog |
| Delivery | Only orders assigned to them | Mark orders as delivered |

### Invitation Flow
1. Owner goes to Staff page → Invite Staff
2. Enters: name, phone number, role
3. System sends WhatsApp message: "You've been invited to manage [Business Name] on Flowdesk. Click here to set up your access: [link]"
4. Staff clicks link → sets a password
5. Staff logs in with their phone number + password

### Staff Dashboard
Staff see the same dashboard as the owner, with data filtered by their role:
- Delivery role: only sees orders where `assignedStaffId = their ID`
- Operations role: sees all orders, customers, products. No revenue dashboard.
- Manager role: sees everything except billing and plan management.

### Activity Log
Every action by a staff member is logged: who did what, to which record, at what time. Visible to owner in Settings → Activity Log.

### Staff Deactivation
Owner can deactivate any staff member instantly. Deactivated staff cannot log in. Their historical actions remain in the log.

---

## 3.9 FEATURE: Real-Time Dashboard

### What it does
Gives the business owner a live view of their operations. Updates without page refresh via Server-Sent Events.

### Dashboard Home Widgets

**Today's Orders**
- Total order count
- Total order value (GHS)
- Count by status (pending, confirmed, processing, fulfilled)

**Live Order Feed**
- Last 10 orders, most recent first
- Each shows: reference, customer, item summary, status, time ago
- New orders appear at top in real time (slide-in animation)
- Click any order → opens order detail drawer

**Messages Requiring Review**
- Count of unclassified/low-confidence/complaint messages
- Preview of each (first 80 chars)
- Click → opens message in context with classification correction option

**Revenue Summary**
- Today / This Week / This Month
- Trend arrows vs previous period
- Payment method breakdown

**Stock Alerts**
- Products at or below reorder threshold
- Color coded: amber (approaching), red (at or below)
- Click → opens product edit

**Outstanding Payments**
- Total owed across all customers
- Top 5 customers by balance

### Orders Board
**Desktop:** Kanban (4 columns side by side)
**Mobile:** Tabbed view (tap to switch between status columns)

Each column header: status name, count, total GHS value for that column
Each card: reference (monospace), customer name, item summary, amount, time ago, staff avatar if assigned
Dragging a card to another column updates the status (same as clicking the button in the detail drawer)

### Navigation Structure
```
Dashboard (home)
Orders
  └── All Orders
  └── Pending
  └── Fulfilled (archive)
Customers
  └── All Customers
  └── With Balance
Products
Payments
  └── Payment Log
  └── Screenshot Review
Messages
  └── All Messages
  └── Review Queue
Staff
Settings
  └── Business Profile
  └── Auto-Reply Templates
  └── Staff
  └── Plan & Billing
  └── Notifications
```

---

## 3.10 FEATURE: Billing and Plans

### Plans

| | Starter | Business | Growth | Enterprise |
|--|---------|----------|--------|------------|
| **Price/mo (GHS)** | 150 | 350 | 700 | Custom |
| **Price/mo (USD est.)** | ~$10 | ~$24 | ~$48 | Custom |
| **WA Conversations** | 500 | 2,000 | 10,000 | Unlimited |
| **Orders/month** | 300 | Unlimited | Unlimited | Unlimited |
| **Staff seats** | 1 | 5 | 20 | Unlimited |
| **Product catalog** | 50 items | Unlimited | Unlimited | Unlimited |
| **CSV exports** | ✗ | ✓ | ✓ | ✓ |
| **Analytics** | Basic | Standard | Full | Full + Custom |
| **Broadcast (V2)** | ✗ | ✓ | ✓ | ✓ |
| **API access (V2)** | ✗ | ✗ | ✓ | ✓ |
| **Support** | Chat | Priority | Dedicated | Account manager |

### Trial
- 14-day free trial on Business plan
- No credit card required to start
- Full feature access during trial
- Day 10: in-app prompt + WhatsApp message from Flowdesk
- Day 13: "1 day left" warning
- Day 14: dashboard shows upgrade modal (not blocked immediately — 48hr grace)
- Day 16: API returns 402 on business operations

### Billing
- Payment via Paystack (MoMo or card)
- Monthly recurring
- Invoices sent to owner's email
- Failed payment: 3-day grace period → suspension
- Annual plan: 2 months free (available on request, Business plan+)

### Plan Enforcement
- Conversations: counted per 24hr window. At 90% of limit → in-app warning + WhatsApp alert. At 100% → outbound auto-replies paused. Inbound messages still processed and stored.
- Orders: at limit → new orders still created and stored, but owner prompted to upgrade. No data lost.
- Staff seats: at limit → invite button disabled, clear upgrade prompt.

---

# PART 4: NON-FUNCTIONAL REQUIREMENTS

## 4.1 Performance

| Metric | Target | Measurement Method |
|--------|--------|-------------------|
| Message to dashboard appearance | < 3 seconds | Automated E2E test |
| Dashboard load (3G, cold) | < 4 seconds | Lighthouse, 3G throttling |
| API response time (p50) | < 100ms | Server logs |
| API response time (p95) | < 500ms | Server logs |
| API response time (p99) | < 1500ms | Server logs |
| Intent classification (rule engine) | < 200ms | Worker logs |
| Intent classification (Haiku) | < 3000ms | Worker logs |
| Auto-reply delivery | < 10 seconds from trigger | E2E test |

## 4.2 Reliability

| Metric | Target |
|--------|--------|
| Uptime (excluding Meta/WhatsApp outages) | 99.5% |
| Message loss rate | 0% |
| Data loss rate | 0% |
| Max queue backlog recovery time | 30 minutes |
| Backup frequency | Daily |
| Backup retention | 30 days |
| RTO (Recovery Time Objective) | 2 hours |
| RPO (Recovery Point Objective) | 24 hours |

## 4.3 Security

| Requirement | Specification |
|-------------|---------------|
| Data at rest | AES-256 (PostgreSQL + S3 default encryption) |
| Data in transit | TLS 1.3 minimum |
| Webhook validation | HMAC-SHA256, timing-safe comparison |
| Auth token lifetime | Access: 15 minutes, Refresh: 30 days |
| Password hashing | bcrypt, cost factor 12 |
| OTP | 6 digits, 10-minute expiry, 5-attempt lockout |
| Rate limiting | 100 req/min per IP, 1000 req/min per authenticated business |
| Audit log | All staff actions logged with actor, action, record, timestamp |
| PII handling | Customer phone numbers masked in logs |
| Data deletion | Soft delete + 30-day hard delete after account cancellation |

## 4.4 Scalability

Architecture is designed for 10x growth from MVP without structural change:

| Scale | Infrastructure | Estimated Cost/month |
|-------|---------------|---------------------|
| 0–100 businesses | Single EC2 t3.medium | ~$40 |
| 100–500 businesses | EC2 upgrade or ECS (2 tasks) | ~$150 |
| 500–2000 businesses | ECS auto-scaling + RDS + ElastiCache | ~$500 |
| 2000+ businesses | ECS multi-AZ + read replicas + CDN | ~$1500+ |

Revenue at 500 businesses (mix of plans): ~GHS 100,000/month (~$7,000/month). Infrastructure cost: ~$150/month. Margin: 97%.

---

# PART 5: METRICS AND SUCCESS CRITERIA

## 5.1 Product Metrics

### North Star Metric
**Active businesses per month:** A business is "active" if at least one inbound message was processed in the last 30 days.

### Input Metrics (lead the north star)
- New business signups per week
- WhatsApp number connection rate (signups who complete connection)
- Day 1 retention (business receives and acts on at least 1 order on day 1)
- Day 14 retention (business still active at end of trial)

### Health Metrics (detect problems early)
- Message processing lag (time from receipt to dashboard appearance)
- Intent classification accuracy (manual review rate as proxy)
- Auto-reply delivery rate
- Failed job rate per queue

### Revenue Metrics
- MRR (Monthly Recurring Revenue)
- Average Revenue Per User (ARPU)
- Trial-to-paid conversion rate
- Monthly churn rate
- Net Revenue Retention

## 5.2 Launch Criteria

Before charging the first customer, all of the following must be true:

```
✓ End-to-end message processing works reliably for 7 days on real traffic
✓ Zero message loss over 7-day period
✓ Dashboard loads in < 4 seconds on 3G (measured on physical device in Ghana)
✓ Intent accuracy ≥ 90% on 200-message validation set
✓ All P0 features complete and tested
✓ Payment processing (Paystack) fully functional
✓ Error tracking (Sentry) active and receiving real events
✓ Backup and restore procedure tested
✓ At least 5 beta businesses completed 14-day trial with positive feedback
✓ Support process defined (who responds to issues, how fast)
```

## 5.3 90-Day Goals (Post-Launch)

| Goal | Target |
|------|--------|
| Active businesses | 50 |
| MRR | GHS 7,500 (~$510) |
| Trial-to-paid conversion | ≥ 40% |
| Day 14 retention | ≥ 60% |
| NPS (Net Promoter Score) | ≥ 50 |
| Support response time | < 4 hours |

---

# PART 6: GO-TO-MARKET

## 6.1 Target Customer Profile

**Primary:** Ghanaian SMEs in Accra and Kumasi
- Revenue: GHS 5,000–100,000/month
- Staff: 2–20 people
- WhatsApp Business account already active
- Receive 50+ orders per month via WhatsApp
- Industries: food distribution, fashion, wholesale grocery, pharmacy, cosmetics

**Secondary (V2):** Businesses in other West African cities (Lagos, Abidjan, Dakar) with the same WhatsApp-first commerce pattern.

## 6.2 Distribution Channels

**Channel 1: Demo-first sales**
Walk into a business. Ask how they manage orders. Show the product live — take out a phone, send a WhatsApp message to their number, watch the order appear on a laptop. Close on the spot. No slides needed.

**Channel 2: WhatsApp business groups**
Ghana has thousands of active WhatsApp groups for traders, entrepreneurs, and specific industries (e.g., "Accra Food Distributors", "Fashion Sellers Ghana"). One demo video posted in the right group → organic spread. Partner with group admins.

**Channel 3: Accountants and bookkeepers**
Accountants who serve SMEs hate WhatsApp-based businesses because there are no records. Flowdesk solves their problem too. Referral partnership: accountant refers client → accountant gets commission on first 3 months.

**Channel 4: Trade associations**
Ghana Union of Traders (GUTA), various market associations. One presentation → warm introductions to hundreds of members. Association endorsement carries credibility.

**Channel 5: MoMo agents**
MTN and Vodafone MoMo agents interact with hundreds of small businesses daily. Referral partnership: agent refers business → agent earns GHS 30 per activated trial.

## 6.3 Pricing Rationale

The GHS 150/month Starter plan is positioned at less than what a business owner would pay for one hour of an accountant's time per month. The sell is: "This replaces one hour of your accountant's time every day."

The GHS 350/month Business plan is positioned as "less than the cost of one missed order per week." For a distributor whose average order is GHS 500, missing 1 order per week = GHS 2,000/month lost. GHS 350 is a 6:1 ROI sell.

---

# PART 7: RISKS

## 7.1 Product Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| Meta changes WhatsApp Business API pricing | Medium | High | Design billing to pass through Meta costs. Monitor Meta policy announcements. |
| Meta restricts API access for regions | Low | Critical | Maintain SMS fallback capability in architecture |
| Intent classification accuracy too low for real use | Medium | High | 200-message validation corpus before launch. Manual review queue as safety net. |
| Business owners don't change behavior (don't check dashboard) | High | High | Mobile-first design. WhatsApp alerts for critical events (owner gets WhatsApp when order arrives, not just dashboard). Day-1 onboarding flow designed for immediate value. |
| SME churn due to price sensitivity | Medium | Medium | Trial period removes barrier. Monthly billing (not annual). Pause option (not just cancel). |

## 7.2 Technical Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| Redis failure breaks queue | Low | Critical | Redis reconnection with 10 retries. DB fallback for message storage. Operations alert. |
| PostgreSQL data loss | Very Low | Critical | Daily backups. 30-day retention. Test restore quarterly. |
| Meta API downtime | Low | Medium | Inbound messages stored locally. No data loss. Outbound paused. Clear owner communication. |
| Haiku API cost spike | Low | Low | Results cached 24hr. Hard spending limit on Anthropic account. Budget alert at $50/day. |

## 7.3 Business Risks

| Risk | Mitigation |
|------|-----------|
| A well-funded competitor enters Ghana | First-mover advantage. Deep local integration (MoMo, Twi patterns). Focus on retention over acquisition. |
| Exchange rate makes USD-priced APIs expensive | Price plans in GHS. Review pricing quarterly. Haiku cost is minimal at scale. |
| Regulatory change affecting WhatsApp Business | Maintain close contact with Meta Ghana team. Diversify to SMS capability as backup. |

---

# PART 8: FUTURE ROADMAP

## V2 Features (Months 4–8)

**Broadcast Messaging**
Send a WhatsApp message to a customer segment (e.g., all VIP customers, all customers who haven't ordered in 30 days). Requires approved Meta marketing templates. Business plan+.

**MoMo Screenshot OCR**
Full automated payment confirmation from screenshots. Remove manual review step. Use Google Vision API for text extraction. Parse amounts from MTN, Vodafone, AirtelTigo screenshot formats.

**Advanced Analytics**
- Best-selling products by period
- Customer lifetime value
- Cohort retention analysis
- Peak hours heatmap
- Revenue forecasting (simple regression)

**Twi Language Support**
Full native Twi interface for the dashboard. Twi-specific intent patterns validated by native speakers.

**Multi-Location**
One Flowdesk account, multiple shop locations. Orders routed to the correct location. Inventory tracked per location.

**Supplier Orders**
Generate and send WhatsApp purchase orders to suppliers directly from the low-stock alert. Supplier confirms via WhatsApp → creates inbound stock record.

## V3 Features (Months 9–18)

**Flowdesk Lending**
Using 6+ months of transaction data (order history, payment reliability, revenue trends), generate a creditworthiness profile. Partner with Ghanaian MFIs and fintechs to offer working capital loans to Flowdesk businesses. Revenue share on originated loans.

**B2B Marketplace**
Verified Flowdesk distributors can be discovered by verified Flowdesk retailers. Retailer sends order → order appears in distributor's Flowdesk dashboard. Payments handled through the platform. Flowdesk takes a transaction fee.

**API Access**
Public API for Growth plan+ businesses. Enables integration with existing accounting software, POS systems, delivery platforms.

**WhatsApp Storefront**
Customer can send "menu" to the business WhatsApp number → receive an interactive list of products. Select items → create order. Requires Meta List Message API.

---

# PART 9: OPEN QUESTIONS

These require resolution before or during MVP development:

| # | Question | Owner | Target Resolution |
|---|----------|-------|-------------------|
| 1 | What Meta verification level is required for the Ghana market specifically? Basic or Advanced? | Engineering | Week 1 |
| 2 | Can we use a single Meta Business Account for all Flowdesk customers, or does each business need their own? | Engineering | Week 1 — affects architecture |
| 3 | What is the realistic cost per business per month in Meta conversation fees at Starter plan (500 conv)? | Engineering | Week 2 |
| 4 | Should the Starter plan restrict conversations or just warn and bill overages? | Product | Week 3 |
| 5 | Do we build a native Android app for MVP or is the web app sufficient? | Product | Week 2 |
| 6 | Is OTP via WhatsApp reliable enough for initial login, or do we need SMS fallback? | Engineering | Week 1 |
| 7 | What is the minimum viable analytics dashboard for Day 1? Revenue + order count sufficient? | Product | Week 4 |
| 8 | For the 14-day trial, does the customer need a card on file or pay after trial ends? | Product | Week 2 |
