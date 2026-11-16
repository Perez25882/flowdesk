# Unified product contract

## Navigation and setup

- `/dashboard` opens the role-scoped overview. `/dashboard?view=work` opens owner decisions and exceptions. `state` and `work` select the queue and workflow. Daily insights remain an owner view.
- `/messages?c=…` is the conversation. `/messages?view=cases&case=…` is its support workspace. A linked case carries staff assignment, history and resolution evidence.
- `/orders?order=…` opens an existing order, including the applicable checkout, preparation, shipment or return. `/orders?workspace=quotes` opens quotes. Products remains the catalogue. Bookings uses managed service operations when configured and retains the legacy tabs for older records.
- `/bookings?view=operations&calendar=day|week|list&visit=…` opens the service diary and a specific visit. Managed dates follow the business IANA timezone. The day and week queries include a padded UTC interval, with exact local-date filtering in the presenter. Each response carries a truncation indicator.
- `/payments?view=invoices&invoice=…` selects an invoice. Payments retains the reviewed and recorded ledger. Team and Reports remain role-gated. Settings holds already supported business, assistant and provider controls. Setup is owner-only.
- Workspaces use existing route names and shared navigation permissions. The sidebar and mobile tabs use the persisted retail or service profile to prioritize relevant modules. A direct route stays subject to the same API `businessId`, current staff identity and relationship checks. Authentication preserves only allowed internal return routes.
- `/onboarding` derives progress from the business, active catalogue, managed service configuration, staff acceptance and provider evidence. `PUT /onboarding/profile` is owner-only and revisioned. The first profile selection leaves managed workflow execution off and customer-facing proposals in owner review. Old records and settings revisions remain readable when the profile changes.
- Messaging readiness checks the saved phone and credentials, current connection evidence and signed receipt completion under the active phone ownership period. Payment readiness uses saved configuration and settlement after the current setup date, gated by the runtime and key mode. Local test setup can display local validation. The app can be used for authorised local business work before external verification.

## Roles and API boundaries

| Surface | Owner | Manager | Operations | Delivery |
| --- | --- | --- | --- | --- |
| Order counts and links | Tenant orders | Tenant orders | Existing order rights | Assigned orders only |
| Overview financial aggregate and reports | `revenue.read` | `revenue.read` | Unavailable | Unavailable |
| Invoices and ledger | Read, create, confirm, void and owner actions | Existing read/create/confirm/void rights | Existing read/create rights | Unavailable |
| Setup and consequential workflow decisions | Owner-only | Unavailable | Unavailable | Unavailable |
| Managed service operations | Tenant configuration and visits | Tenant configuration and visits | Assigned visits and permitted actions | Unavailable |
| Inbox and case work | Messaging rights, can assign | Messaging rights, can assign | Messaging rights, can self-assign available cases | Unavailable |
| Business settings and team | Owner controls | Delegated settings and staff rights | Read-only business settings presentation | Unavailable |

`GET /dashboard/overview` applies the existing delivery assignment and reporting permissions. `GET /conversations/:id/context` discloses bounded linked references only when the corresponding capability is present. `GET /conversations/:id?before=<message-id>` resolves the cursor within the tenant and customer and orders by timestamp and ID. The authenticated media endpoint remains the source of attachment bytes. Managed service visit lookups continue to use tenant and assignment constraints. The legacy diary retains its existing authorization contract and excludes managed visits.

## Decisions, conversation and delivery

- The Inbox offers direct approval of the displayed assistant draft, discard and a separately identified human reply. Exact draft text follows the evidence-gated approval path. Team replacement claims the existing draft state and records one durable outbound send in the same transaction. A competing draft approval and another replacement cannot both be authorized for that message. Queued assistant replies also check for recorded human replies before the provider request.
- Accepted into FlowDesk, queued, sending, accepted by WhatsApp, delivered, read, and failed each have a distinct label. Attachment access is authenticated. Work Center shows the supported requested action, the verified record link and recorded events. Revision and evidence checks remain in the workflow service. The owner can inspect or decline a consequential status reply, retry eligible work, and escalate to review.
- Managed bookings preserve the existing capacity and checkout write contracts. Day and week filters change the read view. Cancellation, rescheduling, attendance, release and final balance still use the existing server state transitions. Quotes and returns continue through commerce policy and stock custody procedures.

## Financial and reporting definitions

- A gateway-verified receipt has an active inbound payment record with `GATEWAY_CONFIRMED` and linked `PaystackSettlement`. Reporting window boundaries in the new overview aggregate use UTC dates. Open balances are current obligations on issued invoices after eligible posted credits and debits. Canceled and expired obligations are excluded. Outstanding invoices are a point-in-time figure, independent of the receipts window.
- An order-linked invoice, standalone invoice and service invoice have explicit server-derived types. Recorded, verified and outstanding amounts are shown separately in GHS. A returned-money adjustment records an attested completed business event through the verified ledger endpoint. Issuing a payment request or creating a payout configuration is a separate state from receiving money.
- An opaque UUID in the standalone invoice draft URL scopes draft creation and recovery to one tenant. The PostgreSQL transaction serializes the identity and preserves debited amounts and immutable inputs. Exact replays return the same invoice. Changed input returns a conflict. Recovery after the response is lost uses the owner-only lookup `/commerce/invoices/drafts/:key`.
- Manual orders opened from the UI use an opaque UUID scoped to the tenant. A PostgreSQL transaction serializes it and commits the order and customer totals together. The internal order ID carries a hash of the tenant and key plus a hash of parsed inputs. A changed replay gets a conflict. Existing manual order callers can omit the key. Authorised staff can recover a committed order by opaque key. Service reservation recovery uses the existing unique `(businessId, requestKey)` and owner or manager permissions.

## Shared design and accessibility

- Use existing CSS tokens and Tailwind design primitives for surfaces, labels, status, spacing and typography. Page headings use `PageHeader`, grouped records use `Panel`, and inputs have associated labels or legends. Provide status text alongside icon and colour. Financial values use the shared GHS formatter and tabular figures.
- `globals.css` sets Plus Jakarta Sans and JetBrains Mono. Use the 21px page title, 18px panel title, 15px body, 13px dense row and 12px supporting metadata roles. Standard panel padding is 16px, with 12–20px gaps between sections and related cards. Use the light neutral page background, white record surfaces, and visible border tokens for groups and fields.
- Keep one primary action at a decision point. Use secondary buttons for alongside actions, underlined links for navigation and danger styling for destructive actions. Standard buttons are 44px high. Compact 32px buttons serve dense groups. Panels and lists are the mobile default. Keep long record sets within their own scroll panes and use one record detail sheet or dialog at a time.
- On small screens show the primary tasks in bottom navigation, full coverage in the menu, and overflow inside record panes. Sheet and dialog controls use Radix focus handling. Tabs implement roving focus, arrow keys and Home/End. The shell has a skip link and visible keyboard focus. The global reduced-motion media rules are retained.
- The acceptance record includes browser dimensions, focus and keyboard probes, automated Axe results when run, API timing from synthetic data and any pending manual accessibility checks.

## Data compatibility and recovery

Batch 5 introduces no database migration. Profile, invoice, approval, receipt, tenant, and audit writes use existing models. A runtime rollback should be done with request admission and workers quiesced. Preserve the database and queue state and reconcile in-flight outbound and checkout work using existing documented runbooks. Batch 5 draft URLs and work center links require the Batch 5 web build paired with its API.

After a lost invoice, order or booking response, reopen the existing form URL to check the current saved record. A completed lookup leads to the authoritative record. Keep the original request key until the action is resolved. Checkout review remains separate from creating a new request. Resolve ambiguous provider evidence through the existing reconciliation procedures before reissuing a payment request.
