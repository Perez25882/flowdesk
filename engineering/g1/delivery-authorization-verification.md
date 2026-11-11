# G1-02 verification

**Recommendation** PASS for the approved local acceptance scope on 2026-11-11. Founder sign-off is pending.

## Source and environment

- Branch `codex/g1-02-delivery-authorization` started at `9022d15efdd6fde568a554bf3933c2fc33b8b8fc` on the clean managed worktree. Its application parent `7fa54655588e9f6a2888d6521ff50cdd516320e8` is the founder-approved G1-01 code. G1-02 has no change to G1-01 ingress, queues, workers, tests or migrations.
- Windows, Node 20.19.0, pnpm 9.12.0, PostgreSQL 17.10, Memurai 8.1.240.0 and Vitest 2.1.9. Each integration attempt used a fresh PostgreSQL cluster and Redis-compatible instance on IPv4 loopback. The fixtures use synthetic credentials and businesses. External provider credentials were removed from the fixture environment and the test subprocesses blocked non-loopback connections.
- The integration harness uses Fastify injection with the production authentication and business-context hooks, order, shipment and dashboard routes, Prisma, and signed access tokens. Proof object I/O uses an instrumented in-memory storage adapter. Database data, transactions, row locks and Redis/BullMQ are real. No production system or provider account was accessed.
- For reproduction, set `DATABASE_URL` and `DIRECT_URL` to the same fresh local test database. Set `G1_02_TEST_DATABASE_URL` and `G1_TEST_DATABASE_URL` to that test URL, and `G1_02_TEST_REDIS_URL` and `G1_TEST_REDIS_URL` to the disposable cache URL. The receipt regression uses the two `G1_TEST_*` variables. Both integration suites opt in to local fixtures. Run from the repository root.

## Executed commands

```sh
pnpm db:migrate
pnpm --filter @flowdesk/api exec vitest run tests/delivery-authorization.integration.test.ts tests/whatsapp-text-receipts.integration.test.ts tests/order-actor.test.ts tests/order-counts.test.ts tests/roles.test.ts tests/payment-integrity.test.ts tests/product-image-upload.test.ts --maxWorkers=1 --minWorkers=1 --testTimeout=30000
pnpm build
pnpm typecheck
pnpm lint
pnpm --filter @flowdesk/api lint
pnpm test
git diff --check
git diff --exit-code 541b7b8 -- apps/web/src/components/shared/ErrorBoundary.tsx
```

Root build, typecheck, lint and test ran with `CI=true`, `TURBO_FORCE=true` and `NODE_ENV=test`. The root test command used the default unit-test environment. The dedicated integration command above supplies evidence for the opt-in suites.

| Check | Exit | Evidence |
| --- | --- | --- |
| `pnpm db:migrate` | 0 | All 25 migrations applied to each fresh cluster. |
| Targeted integration and regression command | 0 | 77 passed across 7 files. G1-02 delivery authorization 12, G1-01 WhatsApp receipts 15, image validation 18, role matrix 14, payment integrity 11, order actor 4 and order counts 3. |
| `pnpm build` | 0 | 3 of 3 tasks succeeded. Vite reported the inherited Browserslist data warning. |
| `pnpm typecheck` | 0 | 4 of 4 tasks succeeded with cache bypass. |
| `pnpm lint` | 1 | Inherited `no-console` violation at `apps/web/src/components/shared/ErrorBoundary.tsx:40`. Turbo stopped on the web package. The baseline comparison for that file exited 0. |
| `pnpm --filter @flowdesk/api lint` | 0 | API lint passed in a separate run. |
| `pnpm test` | 0 | 987 passed across 73 API files. The 27 opt-in cases in two files ran separately in the fixture command above. Web and shared have no test files. |
| `git diff --check` | 0 | Reviewed code and documentation patch. |

The first integration attempt ran the delivery test file alone with the same Vitest options. It exited 1 after a 90-second full-app fixture setup timeout before any assertions. The targeted harness now registers the production delivery surfaces and their authentication hooks directly. The first seven-file run exited 1 with 76 passing and one failing test. The pagination assertion read `meta.total`, while the existing response puts the total at `meta.pagination.total`. The assertion was corrected and all seven files were rerun on another fresh fixture.

## Acceptance coverage

| Requirement | Evidence in the delivery integration suite |
| --- | --- |
| Owner, manager, assigned rider | Manager dispatch retains the rider assignment. Owner and rider can dispatch eligible orders. The assigned rider uploads proof and completes the order. Owner, manager and rider retrieve the same private evidence. Completion retry retains the original timestamp and status history. |
| ID guessing and cross-tenant access | Nine unauthorized actor/ID combinations exercise seven detail, shipment, proof, dispatch and completion surfaces. They receive the same 404 and leave orders, shipment data, proof storage and status history unchanged. Foreign staff assignment is rejected, and generic rider confirmation returns 403. |
| Business-service enforcement | Direct service calls reject unassigned riders, foreign owners and staff from a different business even with a forged manager context. A mismatched shipment cannot be dispatched. |
| Proof reads and writes | Unauthorized requests do not fetch, upload or remove proof. Legacy timestamp and new UUID keys work. A wrong-business proof key is neither fetched nor removed. A proof staged by a reassigned rider is deleted and never becomes the linked proof. |
| Financial data and counts | Rider list and pagination, counts, dashboard badge and status statistics reflect only the rider's assignments. Rider order payloads omit structured amounts and payments. Operations receives tenant-wide counts without revenue. Owner and manager receive their own business totals and only same-tenant linked payments. |
| Reassignment races | The tests observe PostgreSQL blocking the rider's transaction behind a real uncommitted reassignment during dispatch, completion and generic fulfillment. The assignment wins and no order or shipment change is committed by the rider. A separate controlled storage interleaving verifies proof replacement rechecks authorization. |

## Affected files

| Area | Files |
| --- | --- |
| Order policy, routes, persistence and service | `apps/api/src/modules/orders/orders.authorization.ts`, `orders.route.ts`, `orders.repository.ts`, `orders.service.ts` |
| Shipment routes and service | `apps/api/src/modules/shipments/shipments.route.ts`, `shipments.service.ts` |
| Web proof behavior | `apps/web/src/components/orders/DispatchPanel.tsx`, `apps/web/src/hooks/useShipment.ts`, `apps/web/src/lib/api.ts` |
| Web order response handling | `apps/web/src/components/orders/OrderCard.tsx`, `OrderDetailDrawer.tsx`, `OrderTable.tsx`, `apps/web/src/pages/Dashboard.tsx`, `apps/web/src/types/order.ts` |
| PostgreSQL acceptance tests | `apps/api/tests/delivery-authorization.integration.test.ts` |
| Engineering record | `engineering/README.md`, `engineering/g0/defects.md`, `engineering/milestones.md`, `engineering/g1/delivery-authorization.md`, this report |

The [workflow and threat model](delivery-authorization.md) covers the external object cleanup boundary, post-commit effects and evidence already downloaded. Live object storage, hosted deployment and browser end-to-end interactions were outside the executed local acceptance suite.
