# G1-03 verification

**Recommendation** PASS for the verified local acceptance scope on 2026-11-13. Founder sign-off is pending.

**Implementation revision** `21765e2fe0e30480c15aeaca1f21fad92198a168` on `codex/g1-03-gateway-settlement`. Its parent is the founder-approved G1-04 revision `8648d31a494af3ae5e23c55679147d64db11c9b8`. The dedicated checkout was clean before implementation. The final independent confirmation was launched from a clean implementation checkout. The separate verification commit changes documentation only.

## Fixtures and commands

Each integration run initialized a new PostgreSQL 17.10 cluster and Memurai 8.1 Redis-compatible instance on separate IPv4 loopback ports. The run used one empty and one synthetic upgrade database, generated database/cache credentials, Node 20.19.0, pnpm 9.12.0, Vitest 2.1.9 and Prisma 5.22.0. The runner cleared inherited service settings and blocked non-loopback Node sockets and fetches. Tests routed the actual Paystack client to a deterministic local HTTP fixture. No live Paystack credentials, provider accounts, production connections or financial transactions were used.

Set `DATABASE_URL` and `DIRECT_URL` to the selected fixture. The integration runner also sets `G1_03_TEST_DATABASE_URL`, `G1_04_TEST_DATABASE_URL`, `G1_02_TEST_DATABASE_URL` and `G1_TEST_DATABASE_URL` to the fresh database. It sets `G1_03_UPGRADE_DATABASE_URL` and `G1_04_UPGRADE_DATABASE_URL` to the synthetic upgrade database and the four corresponding `*_TEST_REDIS_URL` variables to the fresh cache. The same database is shared across files only within one run, with per-suite fixture identities and single-worker sequencing.

```powershell
pnpm db:generate
pnpm db:migrate
pnpm exec prisma migrate status --schema prisma/schema.prisma
git archive --format=zip --output=$g102Archive 3881366 prisma
pnpm exec prisma migrate deploy --schema $g102Schema
psql -X -h 127.0.0.1 -p $fixturePort -U flowdesk_g1 -d flowdesk_g1_upgrade -v ON_ERROR_STOP=1 -f apps/api/tests/fixtures/g1-04-upgrade.sql
git archive --format=zip --output=$g104Archive 8648d31 prisma
pnpm exec prisma migrate deploy --schema $g104Schema
psql -X -h 127.0.0.1 -p $fixturePort -U flowdesk_g1 -d flowdesk_g1_upgrade -v ON_ERROR_STOP=1 -f apps/api/tests/fixtures/g1-03-upgrade.sql
pnpm db:migrate
pnpm exec prisma migrate status --schema prisma/schema.prisma
pnpm --filter @flowdesk/api exec vitest run tests/paystack-settlement.integration.test.ts tests/payment-relationships.integration.test.ts tests/delivery-authorization.integration.test.ts tests/whatsapp-text-receipts.integration.test.ts tests/paystack-webhook.test.ts tests/billing-subscription-webhook.test.ts tests/payment-integrity.test.ts tests/payment-links.test.ts tests/payment-notifications.test.ts tests/momo-payment-confirmation.test.ts tests/momo-screenshot-claims.test.ts tests/momo-message-processor.test.ts tests/pay-on-request.test.ts tests/order-actor.test.ts tests/order-counts.test.ts tests/wk-pipeline.integration.test.ts tests/webhook-echo.test.ts tests/sec-payout-authorization.test.ts --maxWorkers=1 --minWorkers=1 --testTimeout=30000 --reporter=verbose
pnpm --filter @flowdesk/api exec vitest run tests/paystack-settlement.integration.test.ts --maxWorkers=1 --minWorkers=1 --testTimeout=30000 --reporter=verbose
pnpm build
pnpm typecheck
pnpm lint
pnpm test
pnpm --filter @flowdesk/api lint
pnpm smoke
git diff --check 8648d31 HEAD
git diff --exit-code 541b7b8 -- apps/web/src/components/shared/ErrorBoundary.tsx apps/api/scripts/smoke-test.mjs
git status --short --branch
```

The first deploy/status pair is for the empty database. `$g102Schema` and `$g104Schema` point to extracted baseline schemas. The upgrade deploys G1-02, loads the prior G1-04 seed, deploys G1-04, loads the historical half-settlement seed, then applies G1-03 and checks migration status. Root checks use `CI=true` and `NODE_ENV=test`; only the targeted runs opt into the integration fixtures.

Smoke used a fourth disposable cluster with the migrated database cloned by `createdb -h 127.0.0.1 -p $fixturePort -U flowdesk_g1 -T flowdesk_g1_empty flowdesk_g1_smoke` (exit 0), Redis database 1 and a temporary LF-terminated `.env` with only the synthetic webhook secret. The API ran `node --import tsx src/server.ts` from `apps/api` with `NODE_ENV=development`. `curl.exe --noproxy '*' -sf --max-time 3 "$env:API_URL/health"` exited 0 with HTTP 200 and both services connected. The runner stopped the API and removed the temporary `.env` after the check.

## Results

| Check | Exit | Evidence |
| --- | --- | --- |
| `pnpm db:generate` | 0 | Prisma Client 5.22.0 generated from the final schema. |
| Empty deploy and migration status | 0 / 0 | All 27 migrations applied. |
| Upgrade archives, baseline deploys and seeds | 0 each | Both baseline snapshots applied and both synthetic seeds loaded. |
| Final upgrade deploy and migration status | 0 / 0 | Only the G1-03 migration remained to apply. Legacy rows preserved. |
| Combined G1-03 and regression suite | 0 | 182 passed in 18 files, zero failed or skipped. Includes 35 G1-03, 16 G1-04, 12 G1-02, 15 G1-01 and 104 other tests. |
| Independent G1-03 suite | 0 twice | 35 passed in one file in each of two additional fresh runs, zero failed or skipped. |
| `pnpm build` | 0 | Three workspace tasks succeeded. |
| `pnpm typecheck` | 0 | Four workspace tasks succeeded. |
| `pnpm lint` | 1 | Only the inherited web `no-console` violation at `ErrorBoundary.tsx:40`. Its comparison against the G0 revision exited 0. |
| `pnpm test` | 0 | 987 passed, zero failed, 78 skipped across four opt-in fixture files. Those 78 ran in the combined suite. Web and shared reported no test files. |
| `pnpm --filter @flowdesk/api lint` | 0 | API lint passed. |
| `pnpm smoke` | 1 | 43 passed and 6 failed, matching G0 and G1-01. Signed WhatsApp ingestion, order/payment lifecycle and two-tenant routing passed. The same two stale invite/trial assertions and four connection-health assertions failed with the loopback-only provider configuration. |
| `git diff --check 8648d31 HEAD` | 0 | Commit diff passed whitespace checks. |

An initial development run applied both migrations and returned Vitest exit 1 without retaining per-case output. The first captured run returned exit 1 with 180 passes and two failures. The G1-03 upgrade seed had added a payment to an order whose exact legacy list the G1-04 test asserts. The new payment now uses its own synthetic order. The Redis recovery check expected its receipt to be processed in the first five-job batch despite older due receipts. It now drains through the backlog within a bounded wait and inspects the resulting BullMQ job. All three interrupted-process cases passed in that first captured run and in subsequent passing runs. A separate fixture launch was stopped while stalled after PostgreSQL startup and ran no tests.

## Acceptance evidence

- Signed raw-byte callbacks preserve the exact unsigned 64-bit transaction identity, acknowledge after database acceptance, and return 503 after an injected receipt constraint failure. Invalid signatures and unsupported events produce zero financial effects. Duplicate bytes and byte-distinct events are tested under concurrent admission and competing workers.
- Exact credit, request linkage, order totals and customer balances are asserted. Evidence checks cover different reference, transaction ID, mode, currency, amount, merchant, customer, tenant and order. Tests also cover missing and ambiguous evidence, reversal, a voided ledger, conflicting and half-settled rows, unknown references, cancelled requests and late or timely payments on expired requests.
- Recovery injects a settlement constraint failure after financial writes, disallows new connections to the disposable database, disconnects the Redis client, and verifies post-recovery BullMQ handoff. A timeout and provider HTTP failure cover waiting, recovery and terminal review. An ambiguous initialization stays reviewable, and a retry cannot start an equivalent checkout.
- Three cases kill an actual child worker after a claim and before verification, while PostgreSQL is blocking the ledger insert after verification evidence is persisted, and after the financial commit before the polling pass can continue. The latter confirms completion and credit were already committed together. Recovery and replay assert exactly one credit. An expired lease is injected after termination to avoid a wall-clock minute in each test.
- The seeded upgrade preserves linked and half-settled legacy rows, leaves the new settlement tables empty, and exercises the inherited G1-04 relationship protections. No migration reconciles existing financial records.

The gateway changes cover billing ingress, hosted initialization, settlement and receipt modules, the existing payment ledger transaction, API worker startup, notification handoff, Prisma migration and tenant-scoped reconciliation CLI. The [workflow and runbook](paystack-settlement.md) and [architecture decision](../adr/0004-durable-paystack-settlement.md) describe the new boundaries.

Live hosted verification shape and callback delivery, WhatsApp provider delivery, production migration lock duration, and provider-side disposition of ambiguous checkouts remain unverified. Manual payment entry idempotency and recovery of evicted outbound delivery jobs remain outside this assignment.
