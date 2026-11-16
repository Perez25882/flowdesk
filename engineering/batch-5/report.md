# Batch 5 engineering acceptance

**Recommendation — BLOCKED for full Batch 5 acceptance.** The connected owner and staff workspaces have local verification. General conversation assignment and read state, complete traversal, and manual accessibility evidence still have required work. The [product audit](audit.md), [workspace contract](contract.md) and [continuity file](progress.md) document the implementation and the remaining checks.

## Source

- Branch `codex/batch-5-product`.
- Documented approved Batch 4 tested source `98f0022acffa1af3b007e9a2e20f8bd3b1547224`.
- Current development branch base `93a120301eab18f9fae1c151381aa15a5901d022`, checked against GitHub. Runtime and schema matched the approved Batch 4 source before the changes.
- Compiled runtime `5162d95e5de65bd42e37e772d84c69ba3513f6a5`. Full regression fixtures at `47c5689f7bb45370cf4c273e52ba66d11bc39e7e` and final product browser fixture at `e22a4996513f6c22d5860dd755e8a662f3336b86`. Runtime and migration trees are identical across these revisions.
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
node apps/api/tests/fixtures/batch-workflow-browser.mjs
pnpm smoke:fixture
```

The browser suites use the compiled API and Vite bundle via the release gateway. Set `B2_PLAYWRIGHT` and `B2_CHROMIUM` to the local installed Playwright entry and Chromium binary. Set `B5_AXE` to a local `axe.min.js` for automated accessibility results. Browser fixtures require disposable IPv4 database and Redis endpoints and intercept nonloopback transport. The static verifier ran on Node 20.19.0 and pnpm 9.12.0. PostgreSQL 17 and the local Redis-compatible Memurai 8 instance used separate disposable databases and ports.

## Observations from development candidates

- The first default test run found six legacy pipeline tests failing. The new outbound suppression check called raw SQL, which the mocked database in those tests could not execute. The check now uses the Prisma delegate. Candidate c4 passed 991 API tests and three web tests, with 207 database-gated skips. Integration checks were run separately.
- The first combined product fixture had a setup timeout and skipped assistant coverage because the assistant environment variables were missing. The dedicated repeat used a fresh loopback database and cache and both fixture variable sets. It passed 36 tests with no skips. Its aggregate read measured 52.7 ms for 480 orders and 360 appointments. Initial thread response for 2,400 messages measured 61.1 ms for 200 rows. These are single injected HTTP fixture measurements without browser time.
- The commerce browser exposed duplicate checkout controls after a partial payment. Two different invoice components used the same React key. They now use separate keys, and the fixture checks the invoice checkout after partial settlement. The product browser also identified an ambiguous selector because the same message was visible in the preview and thread. The selector now checks the conversation region.
- Product browser attempts initially reached the functional checkpoints and exited 1. One attempt was waiting for the wrong staff-login API route. A later attempt reached every checkpoint and waited for cleanup. After using the actual staff-login route and closing the gateway and application HTTP connections, the suite exited 0 on repeated fresh services.

## Executed verification

| Command or evidence | Actual result |
| --- | --- |
| `pnpm install --frozen-lockfile --offline` in a new Git archive | Exit 0. All four workspace projects installed. |
| `pnpm db:generate` | Exit 0. Prisma Client 5.22.0. |
| `pnpm --filter @flowdesk/api exec tsc --build --clean` and `pnpm --filter @flowdesk/web exec tsc --build --clean` | Both exit 0. |
| `pnpm run build --force` | Exit 0 on the clean build. Turbo reports three completed tasks in 2m 53s. |
| `pnpm run typecheck --force` and `pnpm run lint --force` | Both exit 0. Four Turbo tasks each. |
| `pnpm run test --force` | Exit 0. API 991 passed, 208 fixture-gated skipped. Web 3 passed. The shared package has no tests. |
| Full PostgreSQL and BullMQ regression selection from the Batch 4 report, plus the Batch 5 suite | Initial exit 1 with 451 passes and two interruption failures. The final independent fresh-fixture run exited 0. Assistant run 32 passed. Main run 421 passed in 34 files. Combined 453 passed, zero failed or skipped. |
| `pnpm --filter @flowdesk/api exec vitest run tests/product-workspace.integration.test.ts tests/assistant-policy.integration.test.ts --maxWorkers=1 --minWorkers=1 --testTimeout=60000 --reporter=verbose` against new services | Exit 0. 37 passed, zero skipped. Includes five workspace tests and the competing same-draft reply test. |
| `node apps/api/tests/fixtures/product-workspace-browser.mjs` | Final exit 0 with `B5_AXE` set. Public signup, synthetic email verification and saved setup for both profiles, direct route and role checks, forced API 503 with retry, delayed and dropped responses for invoice and manual order, session recovery, keyboard tabs and 25 responsive probes. Axe reported zero violations on the five sampled pages. |
| `node apps/api/tests/fixtures/service-operations-browser.mjs` | Exit 0. Synthetic signed lead, exactly one appointment after a dropped response and refresh, only one checkout, exact verified deposit and assigned repair completion. |
| `node apps/api/tests/fixtures/batch-commerce-browser.mjs` | Final exit 0. Product and variant, manual order, verified checkout and partial balance, packing, pickup, return custody, complaint resolution, interrupted provider state, reminders and tenant switch. |
| `node apps/api/tests/fixtures/batch-workflow-browser.mjs` | Exit 0. Actual owner login, supported approval evidence and decision persisted through the mobile Work Center. |
| `pnpm smoke:fixture` | Exit 0. 53 passed, zero failures. Synthetic revoked messaging credentials correctly produced a provider error. |
| Empty, historical upgrade and historical restore database `pnpm db:migrate` and `pnpm exec prisma migrate status --schema prisma/schema.prisma` | Exit 0 for all three paths. Schema reports 39 applied migrations. The existing historical fixtures and exact PostgreSQL appointment/service/invoice/settlement preservation query passed. `pg_dump` and `pg_restore` exited 0. |
| `git merge-base --is-ancestor 98f0022acffa1af3b007e9a2e20f8bd3b1547224 HEAD` and `git diff --check 93a1203 HEAD` | Both exit 0. The addition scan found zero GitHub token, AWS access key, live Paystack key or private-key marker patterns. No Prisma, lockfile, dependency manifest or deploy config changes. |

The workspace-scale PostgreSQL fixture measured 106.6 ms for overview and 179.1 ms for a 200-message response during the final combined run. The independent workspace run measured 74.1 ms and 69.3 ms. Both used 480 orders, 360 appointments, 2,400 messages and 1,001 customers. The test checks a separate page of earlier history and rejects a foreign cursor. These are single local HTTP injection measurements, outside the browser. Vite reported a 28.81 kB gzipped application entry and a 53.26 kB gzipped React chunk. Comparison to historical latency and bundle budgets remains open.

The first full run found the G1 media `after-queue` crash recovery case still `PENDING` after its immediate one-shot dispatcher call, matching the earlier Batch 4 observation. Process exit can precede PostgreSQL releasing its locks. The fixture now takes a bounded row lock before asking the dispatcher to select available receipts. The Batch 2 interruption test reached `RUNNING` while it expected its independent writer to hold a lock. The old child used the production scheduler's five-second transaction timeout. The fixture now holds the same row lock in its own longer transaction and the parent still exercises the unchanged production scheduler. The fresh targeted run preserved all original one-record, one-effect and rollback assertions. It exited 0 with both cases passing and 39 cases excluded by the name filter.

```powershell
pnpm --filter @flowdesk/api exec vitest run tests/whatsapp-media-echo.integration.test.ts tests/workflow-execution.integration.test.ts --maxWorkers=1 --minWorkers=1 --testTimeout=60000 --reporter=verbose -t 'after-queue|rolls back an interrupted worker'
```

## Acceptance journey inventory

| Journey | Final evidence and remaining scope |
| --- | --- |
| 1. New retail business | Verified across local fixtures. Public registration, synthetic verification mail, retail profile resume, catalogue, variants, manual order, signed settlement and pickup. One uninterrupted signup-to-fulfillment browser run remains open. |
| 2. New service business | Verified local. Service profile, time configuration, signed lead, qualification, recovered hold, signed deposit and assigned repair completion. |
| 3. Customer support | Partial. Browser case inspection and evidenced resolution passed. General conversation assignment and a separate read lifecycle remain open. |
| 4. Owner approval | Verified local. Browser displays the requested action and persists the decision. PostgreSQL verifies stale evidence rejection and the competing reply guard. |
| 5. Staff restriction | Verified for tested controls. Delivery finance and inbox denials, assigned order counts, assigned service, and cross-tenant lookups exercised. |
| 6. Financial management | Verified local. Standalone draft and issue, lost response, partial payment, stale checkout replay and final exact settlement. Owner-only adjustment presentation remains outside the browser assertions. |
| 7. Commerce exceptions | Verified local. Ambiguous provider response, recovery and cancellation, returned-item custody and stock restoration. |
| 8. Service exceptions | Partial. PostgreSQL covers capacity conflicts, late settlement, unavailable resources and stale decisions. Browser exception-path traversal remains open. |
| 9. Mobile daily work | Verified for tested routes. Commerce and service flows at 390 × 844, plus 25 probes across 320, 390, 768, 1366 and 1920px widths. |
| 10. Low-bandwidth recovery | Verified local. Forced 503/timeout, repeated click and refresh preserved one invoice, manual order and reservation. Checkout reuses its exact provider action. |
| 11. Refresh and authentication | Partial. Saved record recovery, missing session and return route, logout and tenant switch passed. Mid-action role revocation remains outside the browser assertions. |
| 12. Tenant isolation | Partial. Two tenants and multiple roles exercised for invoice, context, cursor and workspace access. Browser reports, exports and every legacy search path remain open. |
| 13. Prior regressions | Verified local. General workspace tests, 453 combined integration and regression cases on fresh services, and 53 compiled smoke checks passed. The two initial interruption failures also passed separately after fixture corrections. |
| 14. Accessibility | Partial. Keyboard focus and tabs plus Axe on five sampled pages passed. Full keyboard workflow coverage, screen readers and zoom with assistive technology remain open. |
| 15. Product traversal | Partial. Main workflow routes and controls were inspected and sampled. Exhaustive execution of legacy dialogs, every control and error path remains open. |

## Open product scope

- Inbox assignment is represented by a durable customer case. Generic thread assignment and an explicit read/unread lifecycle require additional product work.
- The new scale case covers orders, appointments, customers and message-history pagination. It does not establish performance of all aggregate, export or long-history paths against production-scale traffic.
- An uninterrupted registration-to-fulfilled-order browser journey, cross-tenant exports from several roles, all legacy control interactions, manual screen-reader interpretation and assistive-technology testing require additional final evidence.
- Live Meta, Paystack, mail, hosted delivery and provider account verification belong to the later separately approved process. Actual service credentials or real business records were unnecessary for these tests.

Complete the inbox acceptance gap with tenant-aware conversation assignment and a recorded read state. Verify assigned and unassigned staff, reassignment, scoped lists and direct browser links. Then run a compiled registration-to-fulfillment journey, traverse every legacy control against its expected API and repeat the accessibility and cross-tenant report/export checks from the journey matrix.

## Evidence location

The Windows verification directory is `C:/fd5-c3bc63a/`. Start with `5162-static-status.log`, `final-regression.log`, `final-regression-repeat.log`, `5162-interruptions.log`, `47c5689-signup.log`, `47c5689-product-repeat.log`, `5162-product-test.log`, `5162-commerce-final.log`, `5162-browser.log`, `5162-workflow.log` and `5162-smoke.log`. These local transcripts are supplementary. The commands, exit codes, counts and decision above are tracked here for a new session.
