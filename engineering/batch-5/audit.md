# Product audit and disposition

Baseline `98f0022`. Code inspection records current controls and dependencies. Existing browser and integration results are historical until rerun.

| Surface and user goal | Business and permission | Existing implementation and observed gap | Disposition and acceptance |
| --- | --- | --- | --- |
| Landing, register, login, reset, verify email, staff invitation, privacy, terms, 404 | Public or authenticated email verification | Existing account routes, form validation, refresh cookie and synthetic smoke. Sign-in return path is lost. Account initialization does not select a workflow profile. | RETAIN authentication and legal. IMPROVE return navigation and profile onboarding. Exercise owner and staff sign-in, reload and logout. |
| Shared sidebar, mobile overflow, header, focus and page fallback | All roles | Shared navigation config. Dashboard fetches forbidden records for delivery staff. Booking visibility depends on a single flag. No role guard at deep-link presentation boundary. | IMPROVE using shared capabilities and profile context. Test 320px through desktop and direct routes. |
| Setup checklist, business, assistant, replies, plans, payouts and account settings | Owner and existing permitted staff | Setup is derived from server records. Product-centric checklist lists catalogue for service businesses. WhatsApp health and subaccount presence need clearer readiness language. Settings account tab is evaluated when the module loads. | COMPLETE staged, resumable setup with role-aware settings and explicit provider evidence. Verify defaults and revisits. |
| Dashboard, badges, insights and Work Center | Owner, manager and scoped staff | Existing domain queries and workflow controls. Money due totals only six displayed customers. Empty or errored sources can appear as zero. All orders, payments, stock and setup queries fire regardless of role. | CONSOLIDATE bounded domain figures and links to owning screens. Prove financial, tenant and assignment scope. |
| Inbox, message thread, reviews, media, drafts and composer | Messaging capabilities | Paged signed messages, protected media and existing reply controls. Conversation URL is stable. Customer context and cases require unrelated pages. Exact accepted vs delivered display requires inspection. | IMPROVE owner and staff oversight with current domain evidence. Test takeover, proof access and case assignment. |
| Orders list and board, detail drawer, new order, preparation, dispatch, pickup and returns | Commerce, role and assignment scoped | Existing pagination, filters, trusted state transitions, invoice and custody actions. Detail is held in component state. Delivery sees controls granted to order creators. | IMPROVE deep links and capability visibility. Verify stages and concurrent assignment checks. |
| Products, edit forms, variants, stock | Commerce and catalogue capability | Batch 3 catalogue, stock and pricing workflows. Main nav advertises stock even on service-only profiles. | RETAIN and make relevance-aware. Run actual product editing and concurrency regressions. |
| Bookings, legacy diary and service operations | Service, owner/manager or assigned worker | Existing appointment and managed service settings, quotes, stages and payments. Managed visits sit behind an extra tab, dates are a flat list and navigation loses selection. | COMPLETE day/week/list framing and links with business-local current state. Verify deposits and closure. |
| Customers and detail | Customer-read roles | Existing customer search and order/payment information. Need context links and precise empty/error states. | IMPROVE where workflows need it. Verify cross-tenant lookups. |
| Payments, review and standalone invoices | Payment and revenue capabilities | Ledger page and review affordances. Standalone invoice creation and reminder settings are attached to the dashboard commerce panel. | CONSOLIDATE financial actions. Test refresh and duplicate handling. |
| Staff, activity, invitations and access changes | Owner/manager and current role permissions | Existing invite, revoke, activity, assignment services. Role controls and routes need consistent client presentation. | RETAIN and connect to the relevant work. Test assignment and stale sessions. |
| Reports and export | Revenue capability | Tenant-scoped windows and CSV, existing totals can be distinguished from payment initiation. Service and workflow outcomes need coverage. | IMPROVE filters and verified definitions. Test scoped data and larger fixtures. |

Implementation preserves the existing authenticated route names and domain services. Any unverified interaction remains open in the final acceptance matrix.

## Implemented surface checks

| Area | Control and source | Acceptance evidence to record |
| --- | --- | --- |
| Account and tenant | Owner and staff login, verification redirect, role navigation, direct route access, return destination, logout and team invitation. Auth refresh cookie and tenant middleware. | Browser tenant switch, role access and expired session. Invitation delivery still depends on the synthetic or configured transport. |
| Setup | Profile selection, links to the existing business, catalogue, service, team, provider and assistant forms. Current database revisions and observable receipt state. | Reopen saved setup for retail and service in Chromium. Attempt stale or staff writes with Fastify on PostgreSQL. |
| Overview and reporting | Current orders, cases, visit states, verified receipts, invoice balances, workflow decisions, report window and CSV download. | Query bounded synthetic volumes and verify scoped amounts. Check empty, denied, error and retry states. |
| Work center | State filter, current workflow detail, order and visit links, approval, rejection, retry, escalation and cancel. | Run browser approval and G1/Batch 2 workflow suite including stale or changed evidence. |
| Inbox | Search, needs-you filter, deep-linked thread, earlier history, current draft, secure download, context links and customer cases. | Scoped history pages, approved/dismissed draft race, signed acceptance and delivery evidence, case history, blocked recipients and role checks. |
| Commerce | Product fields and variants, quote and policy form, manual order, detail, preparation, payment link, dispatch or pickup, return custody, case assignment and resolution. | Browser order and verified payment, replayed checkout, return restoration and verified support proof. PostgreSQL checks exact stock, assignment and tenant rules. |
| Service operations | Business timezone and hours, closure and availability, staff resources, leads, calendar, slot selection, timed holds, checkout, lifecycle, attendance and notices. | Browser lead to held deposit, signed settlement, assigned completion and reloading a saved booking. PostgreSQL includes conflict, late payment and stale resource tests. |
| Finance | Totals by evidence, ledger filters, record and verify, scoped invoice detail, standalone draft, issue, send, cancel, reminder and adjustment. | Browser standalone draft and checkout through signed partial and completed settlement. PostgreSQL verifies accounting, idempotency and tenant scope. |
| Delivery | Assignment-scoped counts, order list and detail, permitted dispatch and shipment evidence UI. | Real PostgreSQL G1 authorization cases and denied financial route in browser. |

## Defect register

| Finding | Disposition |
| --- | --- |
| Settings and overview exposed confusing links or made queries the logged-in role could not use. | Shared route role presentation, owner-only settings controls and scoped aggregate reads. |
| Queued automation could overlook a dashboard human send. | Durable human reply intent, worker suppression check before provider transport and transactional same-draft replacement. |
| Standalone invoice, manual order and reservation recovery after a lost HTTP response was unclear. | Opaque tenant-scoped request keys and exact saved-record lookup. Checkout retains its existing provider-version guard. |
| Independent checkout and adjustment components used the same React key after partial payment. | Separate React keys. The commerce browser checks that one payment control remains and the exact after-partial balance is collected. |
| Legacy booking forms encoded a JSON string twice. | Hooks now pass the form object through the central API encoder. |
| Case lists support assignees. Generic conversation assignment and a dedicated unread/read receipt remain open. | Explicit gap. Inbox still presents unhandled and case assignment states from durable records. |
| No automated inventory covers every legacy modal, action and responsive state. | Track any uncovered cases in the acceptance report and continue the product-wide traversal. |
