# G1-02 delivery authorization and tenant isolation

The authenticated business ID scopes every order and shipment. Shipment routes use the order ID and the existing order capabilities. An authenticated caller sees the same `404 Order not found` for a missing, deleted, foreign, or inaccessible order. A caller without the route capability receives 403. An authorized order with no shipment returns `shipment: null`.

## Role and permission contract

| Actor | Operational scope | Dispatch, upload proof, complete | Order statistics |
| --- | --- | --- | --- |
| Owner | Orders in their business | Existing order lifecycle rules | Counts and financial totals |
| Manager | Orders in their business | Existing order lifecycle rules | Counts and financial totals |
| Operations | Orders in their business | Existing order lifecycle rules | Counts |
| Delivery | Orders currently assigned to their staff ID in their business | Existing delivery actions on those orders | Counts for their own assignments |

Read and proof retrieval require `orders.read`. Dispatch, proof upload and delivery completion require `orders.transition`. Delivery actors can use the generic order status endpoint for `FULFILLED` only. Changing the assignee requires the existing `orders.assign` capability and an active staff member from the same business. Staff on the shipment and order object routes must match an active membership and role in that business. The owner is the authenticated business principal.

`GET /orders/stats` always returns `totalOrders` and `byStatus`. The `totalRevenue`, `totalPaid` and `pendingAmount` keys require `revenue.read`. The count-only branch queries counts without selecting amounts or querying payments. A delivery actor's assignment overrides any list or count `staffId` query. Delivery order list, detail and completion responses omit structured prices, totals, payments and raw conversation text while keeping parcels, contacts, delivery addresses and operational notes. Order reads filter linked payment records by business even when the caller can read payments.

## Shipment workflow

1. Dispatch checks the capability and order scope at the route and again in the delivery transaction. The transaction locks the matching PostgreSQL order row, validates the transition and writes shipment metadata, the order status and status history. Dispatch preserves any existing assignment and records the staff dispatcher separately.
2. Proof retrieval resolves metadata through the scoped order. The private object key must belong to that business and order. Legacy timestamp keys and new per-order UUID keys are supported. The authenticated response and browser request use `no-store`.
3. Proof upload checks scope before it stages an object. After upload, it locks and reauthorizes the order in a transaction before replacing the proof key. If the transaction rejects the operation, the service attempts to remove the staged object. The previous proof remains linked. After a successful replacement, the service attempts to remove the previous in-scope object.
4. Delivery completion locks and reauthorizes the order before it records delivery and the order status transition. Repeating the shipment completion keeps the existing delivery timestamp and history. Generic order fulfillment uses the same order lock and remains available for the existing pickup workflow. Notifications and other post-transition effects run after commit.

## Threat model

| Threat | Enforcement |
| --- | --- |
| A rider guesses another order ID, submits a crafted request, or calls the generic status endpoint | Business and current assignment checks before object access, plus a second check under a row lock for mutations |
| A caller supplies an ID from another business | Order and shipment business predicates, active staff membership and same-business assignment validation |
| A manager reassigns an order while an old rider's mutation is in flight | Reassignment and delivery writes serialize on the same order row. When reassignment wins, PostgreSQL rechecks the assignment predicate and the former rider's mutation is denied |
| An existing shipment references an object belonging to another business or order | Proof read and object deletion validate the key's business and order path before contacting storage |
| A rider enumerates other assignments or infers business revenue | Scope list, counts, badges and order statistics to the rider. Omit structured financial fields and restrict revenue queries to `revenue.read` |

The lock protects database writes. A read authorized before a concurrent reassignment may already be in flight. Downloaded evidence remains with the recipient. Free-form operational notes are provided by the business and may contain text it chooses to share. Failed private-object cleanup is logged. Durable recovery of object and notification side effects is tracked under G1-09. G1-02 adds no database migration.
