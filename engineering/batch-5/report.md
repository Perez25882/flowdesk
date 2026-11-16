# Batch 5 engineering acceptance

Verification is in progress. The [product audit](audit.md), [workspace contract](contract.md) and [continuity file](progress.md) document the implemented surfaces and the outstanding checks.

## Source

- Branch `codex/batch-5-product`.
- Documented approved Batch 4 tested source `98f0022acffa1af3b007e9a2e20f8bd3b1547224`.
- Current development branch base `93a120301eab18f9fae1c151381aa15a5901d022`, checked against GitHub. Runtime and schema matched the approved Batch 4 source before the changes.
- The separate `launch` worktree was inspected and preserved.

## Verification procedure

Use a short-path disposable checkout and Node 20, pnpm 9, PostgreSQL 17 and Redis or a compatible local Redis server. Use new databases and cache instances on explicit loopback ports, synthetic fixture credentials and application-level transport stubs. See [Batch 3](../batch-3/closure-report.md#reproduction-commands) for G1 environment variables and [Batch 4](../batch-4/report.md#reproduction-commands) for suite selection and historical data. Add `tests/product-workspace.integration.test.ts` to the Batch 4 aggregate. Run the assistant-policy suite separately as in Batch 4.

```powershell
pnpm install --frozen-lockfile --offline
pnpm db:generate
pnpm run build --force
pnpm run typecheck --force
pnpm run lint --force
pnpm run test --force
pnpm db:migrate
pnpm exec prisma migrate status --schema prisma/schema.prisma
pnpm --filter @flowdesk/api exec vitest run tests/product-workspace.integration.test.ts tests/assistant-policy.integration.test.ts --maxWorkers=1 --minWorkers=1 --testTimeout=60000 --reporter=verbose
node apps/api/tests/fixtures/product-workspace-browser.mjs
node apps/api/tests/fixtures/batch-commerce-browser.mjs
node apps/api/tests/fixtures/service-operations-browser.mjs
pnpm smoke:fixture
```

The browser suites use the compiled API and Vite bundle via the release gateway. Set `B2_PLAYWRIGHT` and `B2_CHROMIUM` to the local installed Playwright entry and Chromium binary. Set `B5_AXE` to a local `axe.min.js` for automated accessibility results. Browser fixtures require disposable IPv4 database and Redis endpoints and intercept nonloopback transport.

## Observations from development candidates

- The first default test run found six legacy pipeline tests failing. The new outbound suppression check called raw SQL, which the mocked database in those tests could not execute. The check now uses the Prisma delegate. Candidate c4 passed 991 API tests and three web tests, with 207 database-gated skips. Integration checks were run separately.
- The first combined product fixture had a setup timeout and skipped assistant coverage because the assistant environment variables were missing. The dedicated repeat used a fresh loopback database and cache and both fixture variable sets. It passed 36 tests with no skips. Its aggregate read measured 52.7 ms for 480 orders and 360 appointments. Initial thread response for 2,400 messages measured 61.1 ms for 200 rows. These are single injected HTTP fixture measurements without browser time.
- The commerce browser exposed duplicate checkout controls after a partial payment. Two different invoice components used the same React key. They now use separate keys, and the fixture checks the invoice checkout after partial settlement. The product browser also identified an ambiguous selector because the same message was visible in the preview and thread. The selector now checks the conversation region.
- The compiled service browser passed before the latest booking recovery change, including verified deposit, mobile staff assignment and completion. The final run must also recover exactly one booking across a lost response and refresh.
