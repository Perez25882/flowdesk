# Batch 4 engineering acceptance

**Recommendation — PASS for the verified local scope.** All 15 acceptance journeys have local evidence. Founder review is pending.

The tested source checkpoint is `98f0022acffa1af3b007e9a2e20f8bd3b1547224` on `codex/batch-4-service`. The runtime last changed in `5ae377ac44334bfa7979730a867f3ef077a46217`. The subsequent commits add browser and service test coverage.

## Source and test boundary

The branch starts at `afac8cd91a656cda62350d55f041a956b356c38a`. The application and Prisma source at that commit matches founder-approved Batch 3 `c95d50a15308def0ad2d6e9f80faa85f41bbfbac`. The approved Batch 2 ancestor is `0f792ae67341bed49d655115aab0f0c378b875e0`. The separately preserved `launch` worktree contained 44 pre-existing modifications when checked.

Verification used Node 20.19.0, pnpm 9.12.0, disposable IPv4-loopback PostgreSQL 17.10, Memurai 8.1.240.0 with BullMQ, local Fastify, Chromium 157.0.8103.39 at 390 × 844, and signed synthetic Meta and Paystack transports. The test shell stripped existing application configuration and blocked outbound connections from the synthetic transports. Git activity targeted the source repository. No customer data, provider accounts, production services or live financial transactions were used.

## Feature and acceptance matrix

| Journey | Implementation and verification |
| --- | --- |
| 1. Inquiry to completion | Signed receipt and workflow version 4, one qualified lead, current quoted slots, booked assignment, physical execution history and signed notification delivery. |
| 2. Deposit | Exact invoice and payment relationship, checkout and independent provider verification, held capacity, balance and reschedule. |
| 3. Last slot | Concurrent Fastify requests yielded one commitment and one appointment identity on successful replays. |
| 4. Resources | Two eligible staff and two equipment alternatives admitted parallel work. The third request, tenant mismatch and overlapping database write were rejected. |
| 5. Changes | Reschedule preserves the original invoice and advances the notice revision. Cancellation releases capacity and suppresses stale notices. |
| 6. Late deposit | Authenticated provider verification records payment on the expired visit's invoice. Another customer keeps the released slot. |
| 7. Consultation | Signed inquiry, qualification questions, consultation option and assigned completion through the shared workflow. |
| 8. Repair | Configured ordered stages, evidence, completion guard and pay-after-service. The browser journey also exercises exact deposit on a repair. |
| 9. Reminder and attendance | Template approval, current consent and verified balance guard, signed delivery callback, cancellation suppression and a no-show after the authorized grace period. |
| 10. Customer care | A scoped service quality case rejects another customer's closure evidence. A matching signed confirmation allows closure. One opted-in invitation reached provider acceptance. The signed reply became a new lead, and a stopped preference suppressed the other invitation. |
| 11. Browser | Compiled mobile owner and staff workflow passed with real login, service setup, signed lead, approval, exact deposit, checkout refresh, assigned staff stage and owner history. |
| 12. Isolation | Foreign checkout and appointment requests, wrong staff assignment, rider access, staff role changes and financial fields on assigned operational views were exercised. |
| 13. Recovery | Actual compiled worker interruption around reservation, deposit confirmation, notice and completion handoff. Reconciliation preserved one booking, ledger credit, completion record and each notification. |
| 14. Calendar | Local midnight, closures, prep and cleanup windows, repeated and skipped DST time and advance limit. |
| 15. Prior platform | All 435 G1, Batch 2 and Batch 3 regression cases passed on the final runtime. The combined run also passed 11 service cases. |

The [service contract](service-contract.md) describes the API, operator handoffs, transaction boundaries, financial rules, staff and resource controls, threat model, message policy and recovery. [ADR 0011](../adr/0011-managed-service-reservations.md) records the architecture. The [progress and handoff record](progress.md) identifies the next step.

## Executed commands

| Command | Exit and evidence |
| --- | --- |
| `pnpm install --frozen-lockfile --offline` | 0. Existing locked dependencies. |
| `pnpm db:generate` | 0. Prisma client generated using local engines. |
| `pnpm --filter @flowdesk/api exec tsc --build --clean` and `pnpm run build --force` | 0 each. Clean API, shared and web build on the sealed source. Vite regenerated the web output. |
| `pnpm run typecheck --force` | 0. All workspace tasks. |
| `pnpm run lint --force` | 0. All workspace tasks. |
| `pnpm run test --force` | 0. 991 API and 3 web tests passed. The API reported 202 fixture-gated skips. Shared has no test files. |
| `pnpm --filter @flowdesk/api exec vitest run tests/service-operations.integration.test.ts --maxWorkers=1 --minWorkers=1 --testTimeout=60000 --reporter=verbose` | 0 on two independent fresh-fixture runs. Each passed all 12 cases with zero skips. Vitest reported 47.95 and 98.04 seconds. |
| Combined PostgreSQL, BullMQ and Fastify campaign below | 0 in both invocations. 31 assistant plus 415 serial cases passed, 446 total. This contains 435 prior-platform cases and 11 service cases. |
| `node apps/api/tests/fixtures/service-operations-browser.mjs` | 0. Owner and assigned staff completed the compiled mobile workflow. |
| `node apps/api/tests/fixtures/service-rollback.mjs` | 0. Approved Batch 3 gated health, frozen ingress and service routes, SQL guard, and single service notice after roll-forward. |
| `pg_dump --format=custom` and `pg_restore --exit-on-error` | 0 each. Restored managed appointment, invoice, workflow and outbox proof matched one row. |
| `pnpm db:migrate` and `pnpm exec prisma migrate status --schema prisma/schema.prisma` | 0 on the empty, historical and exact approved Batch 3 paths. A PostgreSQL query verified the unchanged historical service, appointment, invoice and provider settlement. Schema has 39 migrations. |
| `pnpm smoke:fixture` | 0. The compiled gateway served the SPA deep link and preserved an API JSON 404. All 53 smoke checks passed. |

Git source equivalence and both ancestor checks exited 0. `git diff --check afac8cd HEAD` exited 0. The dependency manifest, lockfile and deployment config had no additions. A tracked source scan found no GitHub tokens, AWS access keys, live Paystack keys or private-key blocks in the added implementation and fixtures. The production Render service is configured for `main` with automatic deploy disabled.

## Reproduction

Use an isolated checkout with the frozen lockfile and a disposable PostgreSQL and Redis pair. The dedicated integration suites require `G1_BATCH_DATABASE_URL` and `G1_BATCH_REDIS_URL`. The [Batch 3 fixture setup](../batch-3/closure-report.md#reproduction-commands) documents the remaining G1 fixture variables. For the browser, point `B2_PLAYWRIGHT` to the installed Playwright entry and `B2_CHROMIUM` to the installed browser. The rollback fixture also uses `B4_PRIOR_BIN` to point to an archived, compiled `c95d50a`. Its older runtime listens behind a health-only access gate with its normal schedulers quiesced.

Apply the historical G1 and Batch 2 seeds, take the custom-format historical dump, and restore it to a distinct disposable database. Apply `4081a34` and `apps/api/tests/fixtures/batch3-completion-preupgrade.sql`, then apply the approved `c95d50a` Prisma schema and `apps/api/tests/fixtures/batch4-preupgrade.sql`. Apply the current additive migration last. The exact preservation query matched the historical appointment, legacy service schema fields, original invoice amount and Paystack settlement, with no managed visit inserted for the historical appointment.

The combined campaign executed the following PowerShell commands with actual PostgreSQL and Redis. The separate assistant invocation keeps its process startup isolated.

```powershell
$opts = @('--maxWorkers=1', '--minWorkers=1', '--testTimeout=30000', '--reporter=verbose')
pnpm --filter @flowdesk/api exec vitest run tests/assistant-policy.integration.test.ts @opts
$suites = @(
  'tests/whatsapp-media-echo.integration.test.ts',
  'tests/commerce-execution.integration.test.ts', 'tests/workflow-execution.integration.test.ts',
  'tests/batch-reliability.integration.test.ts', 'tests/paystack-settlement.integration.test.ts',
  'tests/payment-relationships.integration.test.ts', 'tests/assistant-router.test.ts',
  'tests/assistant-scenarios.test.ts', 'tests/negotiation-gate.test.ts', 'tests/sec-booking-write.test.ts',
  'tests/enquiry-led.test.ts', 'tests/send-reply.test.ts', 'tests/sec-autonomy-disclosure.test.ts',
  'tests/assistant-delivery-capture.test.ts', 'tests/delivery-authorization.integration.test.ts',
  'tests/whatsapp-text-receipts.integration.test.ts', 'tests/paystack-webhook.test.ts',
  'tests/billing-subscription-webhook.test.ts', 'tests/payment-integrity.test.ts', 'tests/payment-links.test.ts',
  'tests/payment-notifications.test.ts', 'tests/momo-payment-confirmation.test.ts',
  'tests/momo-screenshot-claims.test.ts', 'tests/momo-message-processor.test.ts', 'tests/pay-on-request.test.ts',
  'tests/order-actor.test.ts', 'tests/order-counts.test.ts', 'tests/wk-pipeline.integration.test.ts',
  'tests/webhook-echo.test.ts', 'tests/sec-payout-authorization.test.ts',
  'tests/commerce-completion.integration.test.ts', 'tests/whatsapp-media-capacity.integration.test.ts',
  'tests/service-operations.integration.test.ts'
)
pnpm --filter @flowdesk/api exec vitest run @suites @opts
```

The four previously sensitive outbox, settlement and checkout cases were also repeated with fresh services using `pnpm --filter @flowdesk/api exec vitest run tests/commerce-completion.integration.test.ts tests/whatsapp-media-echo.integration.test.ts --maxWorkers=1 --minWorkers=1 --testTimeout=60000 --reporter=verbose -t 'allocates concurrent signed settlements|killed worker at before-verification|restarts after killing the worker at after-queue|hands off one current-balance'`. Exit 0, four passes and 44 tests excluded by the name filter.

The clean-build and repeat transcripts are under `C:/fd4-4a4107c0/` as `sealed-status.log`, `sealed-service-one.log` and `sealed-service-two.log`. The candidate full run used `flowdesk-flowdesk-batch-vitest-8bc91e24001d4cafbe70e89d519a8626.log` in the Windows temporary directory. The browser, rollback, smoke and targeted repeat transcripts are under `C:/fd3-452c6399/`, with names beginning `b4-candidate3-` and `sealed-legacy-all`.

## Findings during verification

- An owner-created workflow used policy revision zero. The existing PostgreSQL workflow constraint requires a positive revision. The code now persists the active service settings revision. The route-level reservation tests cover the correction.
- The prior Paystack crash fixture rebuilt its signed callback with a fresh timestamp. The receipt identity hashes the signed bytes. Different timestamps produced two valid receipts, so the parent runner could settle through the second receipt while the first worker was paused. The fixture now uses one timestamp per provider transaction and exercises a real exact replay. The payment runtime was unchanged by this fixture correction.
- One early concurrent standalone checkout returned HTTP 500 without a retained database error code. An initial outbox interruption missed its checkpoint when using mixed source and older compiled output. An interrupted media receipt remained `PENDING` once on superseded `d6a50fa`. Its fixture makes one recovery call after child exit, which can precede PostgreSQL releasing a row lock. The earlier transaction timing was unavailable. The frozen full campaign and the fresh targeted repeat passed these cases.
- Early Chromium rehearsals exposed inaccessible label associations and ambiguous test selectors. The UI now explicitly binds field labels to inputs. The browser fixture scopes its selectors and waits for the current revision.

## Supported limits

Active profiles cover personal appointments, consultations, repair and configured staff work. Staff attest off-site locations against the configured area. Financial settlement uses GHS and the existing provider. Configured out-of-window delivery requires an approved tenant utility template. Repeat-service communications require explicit consent and an active conversation window. External providers, deployed configuration and payment traffic remain outside this local verification.
