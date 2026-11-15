# Batch 3 acceptance report

**Recommendation — BLOCKED for full Batch 3 acceptance.** The connected order-linked commerce paths have local test evidence. The remaining required workflows and coverage gaps are listed below.

The integration branch is `codex/batch-3-commerce`. The final implementation is `4081a34163be1e4e286aa11d70131a1445bba870` on approved Batch 2 parent `0f792ae67341bed49d655115aab0f0c378b875e0`. The [implementation register](progress.md) records the baseline and feature disposition. The [commerce contract](contract.md) covers the four operators, workflow version, schemas, APIs, authorization and recovery. [ADR 0009](../adr/0009-commerce-authority.md) records the authority boundaries.

The new commerce module reuses existing SKU rows, order records, stock movements, the G1 Paystack settlement and ledger, shipment controls, the signed WhatsApp outbox and the dashboard. The local checkout and earlier branches are preserved. Online retail and WhatsApp/social retail use the same retail profile. The custom-order profile adds owner approval of the production specification.

## Recorded checkpoints

The original focused run migrated the empty and seeded G1 databases and passed last-unit stock contention. Its signed journey committed the expected quote, order, deposits, balance, shipment and care case. Case resolution returned HTTP 500 because the service passed the full case structure to Prisma as message filter fields. The small correction constructs the exact message scope. In the next run the signed retail, care, consent and custom-pickup journey and contention both passed against fresh PostgreSQL and BullMQ.

An API build initially returned exit 1 from a missing recovery database import. Its corrected build returned exit 0. The first lint returned exit 1 for seven explicit return-type violations. Types were added to the exported functions. Build, typecheck, lint and default tests subsequently returned exit 0. See the final source results for the exact counts.

The final fixture campaign adds a representative approved Batch 2 workflow and approval before applying the Batch 3 migration. It runs full G1 and Batch 2 regressions, the commerce suite, a fresh repeat, actual Chromium owner controls, compiled smoke, and the backup and application rollback rehearsal.

| Gate or campaign | Exit | Observed evidence |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` and `pnpm db:generate` | 0 each | Isolated Windows checkout, Node 20.19, pnpm 9.12 and local Prisma 5.22 engines. |
| `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test` | 0 each | Final runtime snapshot. Default tests reported 991 API passes with 176 fixture-gated skips, and three web passes. The shared package has zero test files. |
| Focused signed commerce, before expanding the fixture | 0 | Two passing tests and zero skips. |
| First full regression | 0 and 1 | Assistant 31 passes. Other suites 389 passes and one media replay failure. Zero skips. |
| Fresh commerce and Batch 2 repeat | 0 | 10 passes across two files and zero skips, including four commerce tests. Wall time reported by Vitest was 213.88 seconds. |
| Isolated media receipt repeat | 0 | 35 passes and zero skips on fresh fixtures. Vitest reported 50.10 seconds. |
| Serial full regression during the return change | 0 and 1 | Assistant 31 passes. Other suites 389 passes and one return audit assertion failure, plus a fixture teardown error. The media replay case passed. Source drift in this run is described below. |
| Final fixed-snapshot full regression | 0 and 0 | Assistant 31 passes. Other suites 390 passes across 30 files. Zero failures and skips. The signed lifecycle with the return checks took 118.62 seconds. Vitest reported 552.37 seconds for the 390-test run. |
| Empty and seeded upgrade migration | 0 each | `pnpm db:migrate` and Prisma status confirmed all 35 migrations applied. The previous version's waiting workflow and approval were preserved. |
| Pre-upgrade `pg_dump` and `pg_restore` | 0 each | A separate restored database returned the expected receipt, payment and baseline relationships. |
| Compiled Chromium, post-migration restore, current and prior app smoke on the final fixed snapshot | 0 each | Owner browser path passed. `pg_dump`, `pg_restore` and the evidence query succeeded. The restored database returned one linked invoice, quote, preparation and case. Current and approved Batch 2 `pnpm smoke:fixture` each reported 53 passes and zero failures against the migrated schema. All these checks also passed before the return change. |

The focused and first full signed lifecycle tests took about 91 and 121 seconds respectively. The fixture includes asynchronous dispatch polling and deliberately injected errors. During final smoke, one Windows working-set sample was 23,011,328 bytes for the PostgreSQL parent process and 72,822,784 bytes for Memurai. The PostgreSQL cluster files occupied 84,151,394 bytes and the compressed browser fixture dump was 197,740 bytes. The sample excludes PostgreSQL child processes. Production latency, throughput and provider usage are unmeasured.

## Operator completion matrix

| Operator | Implemented | Remaining full-scope work |
| --- | --- | --- |
| Sales & Orders | Version 3 signed SKU inquiry, variants, configured quantity and promotional pricing, itemized expiring offers, last-unit holds, owner review for a custom specification, explicit acceptance, and one existing order and movement set. | Free-form specification collection uses the existing G1 review path. Structured production specifications use the documented command and owner approval. Changing terms requires a fresh offer. |
| Payments & Invoices | GHS order invoice, exact verified ledger balance, deposit and balance links, signed settlement, retryable provider reconciliation, and a customer-readable itemized WhatsApp notice. Existing authorized G1 refund recording creates an attested outbound ledger entry without initiating a provider refund. | Standalone invoices lack an invoice-scoped link to G1 payment requests and ledger entries. Add that relationship, fence G1 initialization and settlement by the invoice identity, and verify tenant, replay and balance isolation. Independently scheduled reminders need a consent and template contract with claim-time balance revalidation. The owner can send the authorized payment link from the order today. |
| Fulfillment & Operations | Verified payment release, one packing or production task, explicit physical readiness, assigned G1 dispatch, signed customer notification, pickup confirmation, stock restoration on cancellation before handoff, and owner confirmation of a full tracked-goods return. | Partial or mixed-mode returns remain in staff review. A partial receipt would need itemized custody evidence, a bounded immutable movement identity per accepted quantity and explicit disposition of exchange or refund obligations. |
| Customer Care & Retention | Scoped status replies, durable complaint, cancellation, return and exchange cases, revisioned assignments and outcome evidence, opt-in and opt-out, and one authorized service follow-up. | Follow-up scope is transactional service support. Broader campaigns and provider billing evidence are outside the verified result. |

## Journey acceptance matrix

| Journey | Current evidence |
| --- | --- |
| 1. Retail | Passed in the focused and first full runs. The signed quote produced an order, invoice, warehouse release, shipment and signed delivery. |
| 2. Multiple items and variants | The signed run charged GHS 60 for two units of an independently stocked GHS 30 variant at its 10 percent quantity tier and one GHS 6 item. Two stock movements committed. A later price change prevented acceptance of the stale quote. |
| 3. Custom order | A signed specification waited for owner approval, then created an invoice and verified production task. Before readiness, pickup completion was refused. After explicit preparation and collection, signed delivery completed the workflow. |
| 4. Stock contention | Two real concurrent requests for the last unit produced one hold. A foreign SKU and a stock reduction through the hold were refused. Expiry released the reservation. |
| 5. Payment interruption | G1 real provider and worker interruption cases ran in the full suite. The Batch 3 test injected an invoice insert failure and observed no order or stock movement before successful replay. Duplicate authenticated gateway callbacks produced one credit per reference and one preparation task. |
| 6. Partial payment | GHS 15 independently verified against GHS 60 left GHS 45 due and blocked preparation. Verified balance settlement released one task. |
| 7. Cancellation or return | Signed cancellation opened a case. Owner cancellation competed with preparation release, restored stock once, left the two settled credits intact, and prevented another checkout. The final signed journey confirmed that concurrent owner attestations restore a full tracked return once. The case remains waiting and both settled ledger credits remain unchanged. A foreign owner received 404 attempting the same action. |
| 8. Complaint | Signed wrong-item report created one case. Missing resolution evidence was rejected. Concurrent owner resolution calls with a signed customer confirmation produced one update and one conflict. |
| 9. Tenant and staff | Foreign invoice and case reads were refused. Rider access to quotes, invoices and cases was denied. Stale manager permissions were refused after a role change. |
| 10. Recovery | Batch 3 quote and invoice rollback exercised PostgreSQL. Reused G1 and Batch 2 integration suites exercise provider ambiguity, queue loss, Redis restart, connection failure, reassignment, process death and concurrent claims. Dedicated Batch 3 worker process death during payment release and browser refresh during an ambiguous checkout remain without direct evidence. |
| 11. Owner browser | Chromium passed on the compiled applications. The owner saved product settings, opened the actual order and invoice, recorded preparation, finished a customer-acknowledged case and saw workflow detail. This uses seeded preparation and payment evidence. Signed checkout and shipment behavior are exercised by the server journey. |
| 12. Prior regression | Final fixed-snapshot run passed 421 tests with zero skips. The earlier media admission failure and the independent and serial repeats are recorded below. |

## Release blockers and operating limits

- The invoice model requires an order. Standalone obligations need a customer-scoped billing identity enforced across invoice, payment request, signed settlement and ledger, with negative tests for cross-tenant and cross-customer attachment and independent balances for two invoices belonging to one customer.
- The owner can send a payment link. Independently triggered reminders need a durable reminder identity, consent and channel checks, capped attempts, and current balance and expiry checks at claim time. Verify opted-out, already paid, cancelled, ambiguous and concurrently retried obligations on real fixtures.
- Batch 3 needs focused interruption evidence for settlement through preparation, plus a browser refresh while checkout is ambiguous. Inject termination immediately before and after the durable release, restart on independent fixtures and verify one credit, one preparation task and the same provider reference.
- Retail quotations accept documented catalogue SKUs and a structured production specification. Unknown terms route to review. Free-form clarification, merchant-configurable partial return rules and marketing campaigns have no verified Batch 3 path.
- Local tests use generated identities, loopback databases and deterministic synthetic Meta and Paystack transports. Live Meta templates and delivery, real Paystack accounts or money movement, jurisdictional invoice certification, production load, and deployment remain outside this evidence.

## Regression investigation

The first full run returned HTTP 503 for several of eight concurrent duplicate media deliveries. The route only issues this retryable response if receipt acceptance throws. `git diff --exit-code 0f792ae -- apps/api/src/modules/webhook/text-receipts.ts apps/api/src/modules/webhook/webhook.route.ts` returned 0. The local PostgreSQL log recorded aborted connections around the failure. The route did not preserve the exception detail, so the individual cause remains unverified. The isolated media run and both subsequent serial full runs passed that scenario. No G1 receipt code was changed in response.

The serial full run also reported a new return-audit assertion failure and a Redis teardown error in the commerce fixture. The test checkout received the new audit assertion after Vitest had already loaded an earlier revision of its stock service. The route successfully restored stock and created two return movements, but the loaded service wrote its earlier audit note. The final campaign uses a fixed source snapshot. The fixture closes BullMQ workers and then disconnects its owned Redis clients, including on assertion failure.

## Local reproduction

Use disposable IPv4 loopback PostgreSQL 17 and Redis or Memurai with Node 20 and pnpm 9. Use a short checkout path on Windows. The signed fixture uses synthetic credentials and provider transports. The [G1 fixture instructions](../g1/batch-1-report.md#reproduction) provide the historical migration seeds. Before applying Batch 3 on the upgrade database, deploy the archived approved Batch 2 schema and seed `apps/api/tests/fixtures/batch3-preupgrade.sql` with `psql -X -v ON_ERROR_STOP=1 -f`.

```sh
pnpm install --frozen-lockfile
pnpm db:generate
pnpm build
pnpm typecheck
pnpm lint
pnpm test
pnpm db:migrate
pnpm exec prisma migrate status --schema prisma/schema.prisma
pnpm --filter @flowdesk/api exec vitest run tests/assistant-policy.integration.test.ts --maxWorkers=1 --minWorkers=1 --testTimeout=30000 --reporter=verbose
pnpm --filter @flowdesk/api exec vitest run tests/commerce-execution.integration.test.ts tests/workflow-execution.integration.test.ts --maxWorkers=1 --minWorkers=1 --testTimeout=30000 --reporter=verbose
pnpm --filter @flowdesk/api exec vitest run tests/whatsapp-media-echo.integration.test.ts --maxWorkers=1 --minWorkers=1 --testTimeout=30000 --reporter=verbose
node apps/api/tests/fixtures/batch-commerce-browser.mjs
pnpm smoke:fixture
```

The full prior command uses the [G1 full file list](../g1/batch-1-report.md#reproduction), with `tests/commerce-execution.integration.test.ts` and `tests/workflow-execution.integration.test.ts` added to the second command. Use `G1_BATCH_DATABASE_URL`, `G1_BATCH_REDIS_URL` and `G1_03_UPGRADE_DATABASE_URL` for the commerce suite. Browser verification uses the built app, `B2_PLAYWRIGHT` with a local Playwright ESM path and `B2_CHROMIUM` with an installed browser binary.

```sh
pnpm --filter @flowdesk/api exec vitest run \
  tests/whatsapp-media-echo.integration.test.ts tests/commerce-execution.integration.test.ts \
  tests/workflow-execution.integration.test.ts tests/batch-reliability.integration.test.ts \
  tests/paystack-settlement.integration.test.ts tests/payment-relationships.integration.test.ts \
  tests/assistant-router.test.ts tests/assistant-scenarios.test.ts tests/negotiation-gate.test.ts \
  tests/sec-booking-write.test.ts tests/enquiry-led.test.ts tests/send-reply.test.ts \
  tests/sec-autonomy-disclosure.test.ts tests/assistant-delivery-capture.test.ts \
  tests/delivery-authorization.integration.test.ts tests/whatsapp-text-receipts.integration.test.ts \
  tests/paystack-webhook.test.ts tests/billing-subscription-webhook.test.ts tests/payment-integrity.test.ts \
  tests/payment-links.test.ts tests/payment-notifications.test.ts tests/momo-payment-confirmation.test.ts \
  tests/momo-screenshot-claims.test.ts tests/momo-message-processor.test.ts tests/pay-on-request.test.ts \
  tests/order-actor.test.ts tests/order-counts.test.ts tests/wk-pipeline.integration.test.ts \
  tests/webhook-echo.test.ts tests/sec-payout-authorization.test.ts \
  --maxWorkers=1 --minWorkers=1 --testTimeout=30000 --reporter=verbose
```

The historical rehearsal extracted `prisma` via `git archive` at `3881366`, `8648d31`, `b86b939`, `65a6410`, `e4a4021` and `0f792ae`. Each step ran `pnpm exec prisma migrate deploy --schema <archive>/prisma/schema.prisma`, with the tracked representative fixtures loaded at the appropriate versions. Empty and seeded databases reached the same 35-migration head. The existing workflow and pending approval kept their original generation, status and relationships.

```sh
pg_dump -h 127.0.0.1 -p "$PGPORT" -U flowdesk_g1 -d flowdesk_g1_upgrade --format=custom --file="$PREUPGRADE_DUMP"
pg_restore --exit-on-error -h 127.0.0.1 -p "$PGPORT" -U flowdesk_g1 -d flowdesk_g1_restore "$PREUPGRADE_DUMP"
pg_dump -h 127.0.0.1 -p "$PGPORT" -U flowdesk_g1 -d flowdesk_g1_empty --format=custom --file="$COMMERCE_DUMP"
pg_restore --exit-on-error -h 127.0.0.1 -p "$PGPORT" -U flowdesk_g1 -d flowdesk_g1_upgrade "$COMMERCE_DUMP"
```

These invocations use two independent clusters. The full-source smoke restores the commerce dump into a separate initially empty database, then queries the joined invoice, quote, preparation and case. Run `pnpm smoke:fixture` from the Batch 3 checkout and the compiled approved Batch 2 runtime checkout against the migrated test schema to rehearse application rollback.
