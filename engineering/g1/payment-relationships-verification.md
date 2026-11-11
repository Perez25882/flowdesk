# G1-04 verification

**Recommendation** PASS for the verified local acceptance scope on 2026-11-11. Founder sign-off is pending.

## Source and local fixtures

- Dedicated branch `codex/g1-04-payment-consistency` starts at founder-approved G1-02 commit `3881366cc7da0314517b1c67c0ae0acaa227b26a`. The implementation scope follows the founder's attached G1-04 approval and the checked-in milestone register. A separately titled approved prompt book was unavailable in the checkout and supplied attachments.
- Windows, Node 20.19.0, pnpm 9.12.0, Prisma 5.22.0, PostgreSQL 17.10, Memurai 8.1.240.0 and Vitest 2.1.9. The fixtures used disposable IPv4 loopback services, a fresh database, a separate synthetic upgrade database, and synthetic credentials. The real Paystack client used an instrumented fake HTTP transport. The fixture subprocess blocks non-loopback sockets and fetches.
- API integration used the production payment routes, signed access tokens, authentication and business context hooks. Service calls and direct database writes were verified separately. The final suite includes the G1-01 receipt and G1-02 authorization cases. The G1-02 fixture now asserts that a new cross-tenant ledger row is rejected by PostgreSQL, and the upgrade case still exercises its historical read filter.

## Commands and results

Run from the worktree root with the fixture-specific local connection strings. `DATABASE_URL` and `DIRECT_URL` point to the selected disposable database. For the integration command, set `G1_04_TEST_DATABASE_URL`, `G1_02_TEST_DATABASE_URL` and `G1_TEST_DATABASE_URL` to the fresh database, `G1_04_UPGRADE_DATABASE_URL` to the seeded upgrade database and the three corresponding `*_TEST_REDIS_URL` variables to the fresh cache.

```powershell
pnpm db:generate
pnpm db:migrate
pnpm exec prisma migrate status --schema prisma/schema.prisma
git archive --format=zip --output=$archive 3881366 prisma
pnpm exec prisma migrate deploy --schema $schema
psql -X -h 127.0.0.1 -p $fixturePort -U flowdesk_g1 -d flowdesk_g1_upgrade -v ON_ERROR_STOP=1 -f apps/api/tests/fixtures/g1-04-upgrade.sql
pnpm db:migrate
pnpm exec prisma migrate status --schema prisma/schema.prisma
psql -X -h 127.0.0.1 -p $fixturePort -U flowdesk_g1 -d flowdesk_g1_upgrade -v ON_ERROR_STOP=1 -A -t -f apps/api/scripts/audit-payment-relationships.sql
pnpm --filter @flowdesk/api exec vitest run tests/payment-relationships.integration.test.ts tests/delivery-authorization.integration.test.ts tests/whatsapp-text-receipts.integration.test.ts tests/payment-integrity.test.ts tests/payment-links.test.ts tests/payment-notifications.test.ts tests/momo-payment-confirmation.test.ts tests/momo-screenshot-claims.test.ts tests/momo-message-processor.test.ts tests/pay-on-request.test.ts tests/order-actor.test.ts tests/order-counts.test.ts tests/wk-pipeline.integration.test.ts tests/sec-payout-authorization.test.ts --maxWorkers=1 --minWorkers=1 --testTimeout=30000
pnpm build
pnpm typecheck
pnpm lint
pnpm --filter @flowdesk/api lint
pnpm test
git diff --check
git diff --exit-code 541b7b8 -- apps/web/src/components/shared/ErrorBoundary.tsx
```

The archive holds the baseline migration directory. `$schema` is the extracted baseline Prisma schema and is used only for the pre-seed deploy on the upgrade database. The two Prisma deploy/status pairs for the final schema use the fresh and upgrade database respectively. Root build, typecheck, lint and test use `CI=true` and `NODE_ENV=test`. The first run set `TURBO_FORCE=true`. The post-lint-correction run used normal local caching, with the changed API tasks rerun.

| Check | Exit | Evidence |
| --- | --- | --- |
| `pnpm db:generate` | 0 | Generated Prisma Client 5.22.0. |
| Fresh migration and status | 0 / 0 | 26 migrations applied. |
| Baseline archive, deploy and seed | 0 / 0 / 0 | G1-02 schema plus two synthetic tenants, three customers, orders, valid and invalid financial rows, and legacy staff activity. |
| Seeded upgrade migration and status | 0 / 0 | Applied only the G1-04 migration. |
| Read-only audit | 0 | Same-business order/customer mismatch, foreign order tenant and customer codes, and inconsistent settlement identity. Four findings across three seeded rows. |
| Targeted Vitest command | 0 | 119 passed across 14 files in each of two successful runs on fresh fixtures. The final run exercised the lint correction. 16 G1-04 PostgreSQL cases, 15 G1-01 receipt cases, 12 G1-02 authorization cases and 76 related regression cases. Zero failed or skipped. |
| `pnpm build` | 0 | 3 of 3 tasks succeeded on both runs. The first run bypassed the cache. The final run rebuilt the API and reused unchanged web/shared outputs. Vite reported the inherited Browserslist data warning. |
| `pnpm typecheck` | 0 | 4 of 4 tasks succeeded on both runs. Final API typecheck executed against the correction. |
| `pnpm lint` | 1 | Final run reproduced only the inherited `no-console` error in `apps/web/src/components/shared/ErrorBoundary.tsx:40`. The comparison against G0 exited 0. |
| `pnpm --filter @flowdesk/api lint` | 0 | Final API lint passed after the null-check correction. |
| `pnpm test` | 0 | 987 passed across 73 API files. 43 opt-in cases across three files were skipped by default and ran in the targeted command. Zero failed. Web and shared have no test files. |
| `git diff --check` | 0 | Working-tree and staged whitespace checks succeeded. |

An initial fixture run applied both migrations and ran the SQL audit successfully. The temporary runner exited 1 at its expected-output assertion because it still expected two findings after the seed was expanded to include a cross-tenant row. The runner expectation was corrected and the verification rerun on fresh databases. A preliminary API typecheck exited 2 on the newly nullable `StaffActivity.staffId`. The staff activity read now preserves its existing staff-only response shape explicitly.

The first targeted Vitest run exited 1 with 103 passing regression tests and 16 skipped payment tests. The payment fixture timed out in its setup hook before any assertions. The next run used a fake HTTP transport in place of a partial Paystack module mock and completed payment fixture setup. The initial timeout's cause was unconfirmed.

The first full and API lint commands each exited 1. API lint flagged two `eqeqeq` violations in the new null checks. The checks now test null and undefined explicitly. The first cache-bypassed build, typecheck and default test suite exited 0. The default suite reported 987 passed, 43 opt-in skipped and zero failed. The final results in the table use the corrected code.

## Acceptance evidence and limits

The integration suite covers same-customer and same-business payment, wrong customer, foreign customer/order/payment, missing and archived order, unallocated credits and refunds, staff permissions and attribution, owner activity, screenshot duplicate handling, claim confirmation and attestation, void, provider preflight, duplicate order-linked requests, real PostgreSQL contention and rollback, exact settlement identity, fresh database constraints and historical upgrade preservation. The rollback case injects a database check failure during audit insertion after ledger and total changes and checks the entire transaction was undone.

The implementation changes the payment route, service and repositories under `apps/api/src/modules/payments`, customer total recomputation, staff activity persistence and reads, the assistant payment-link caller, and the screenshot archive caller. The data changes are in `prisma/schema.prisma` and `20261111090000_financial_relationships`. The SQL audit, upgrade fixture and payment integration suite accompany the implementation.

The [financial contract and reconciliation notes](payment-relationships.md) record historical cases and rollout boundaries. Live Paystack behavior, production migration lock duration and production reconciliation remain unverified. The separate G1-03 gateway receipt, replay and settlement orchestration assignment remains open.
