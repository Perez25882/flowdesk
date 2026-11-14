# G1-06 verification

**Recommendation** PASS for local acceptance on 2026-11-14. Founder sign-off is pending.

The approved parent is `65a6410934e238d393844c60132f84153f88e038`. The G1-05 implementation and verification history remain in its ancestry. G1-06 started from a clean worktree on `codex/g1-06-whatsapp-media-echo`. The implementation under test is `c88c4ddbb66a3a112390e90df49f74d2fb4021c0`. See the [source inventory](whatsapp-event-inventory.md), [workflow and recovery runbook](whatsapp-media-echo.md) and [architecture decision](../adr/0006-whatsapp-media-echo.md).

## Fixtures

The local Windows runs use Node 20.19.0, pnpm 9.12.0, PostgreSQL 17.10, Prisma Client 5.22.0 and a Redis-compatible Memurai 8.1.240 instance. Each acceptance invocation starts a fresh PostgreSQL cluster and Memurai process on distinct loopback ports. All tenants, signatures, provider tokens, filenames and objects are synthetic. Inherited provider configuration is cleared and Node socket and fetch connections are restricted to loopback. The test fixture maps Meta Graph and attachment URLs to a local HTTP server and points the real S3 client at its synthetic storage endpoint. The runs use no production, live Meta, real bucket, customer data or paid services.

Set `G1_06_TEST_DATABASE_URL` and `G1_06_TEST_REDIS_URL` to the current disposable pair. The combined run uses the same pair for `G1_TEST_*` and prior G1 `G1_02_TEST_*` through `G1_05_TEST_*`. Set `G1_03_UPGRADE_DATABASE_URL`, `G1_04_UPGRADE_DATABASE_URL` and `G1_06_UPGRADE_DATABASE_URL` to the separate synthetic upgrade database in the run's cluster. Set `DATABASE_URL` and `DIRECT_URL` to whichever database the migration is targeting. Root workspace checks use `CI=true`, `NODE_ENV=test` and no integration opt-in variables.

## Commands

```powershell
pnpm db:generate
pnpm db:migrate
pnpm exec prisma migrate status --schema prisma/schema.prisma

# Upgrade database. Each $archive and $schema denotes that revision's temporary ZIP and extracted Prisma schema.
git archive --format=zip --output=$archive 3881366 prisma
pnpm exec prisma migrate deploy --schema $schema
psql -X -h 127.0.0.1 -p $fixturePort -U flowdesk_g1 -d flowdesk_g1_upgrade -v ON_ERROR_STOP=1 -f apps/api/tests/fixtures/g1-04-upgrade.sql
git archive --format=zip --output=$archive 8648d31 prisma
pnpm exec prisma migrate deploy --schema $schema
psql -X -h 127.0.0.1 -p $fixturePort -U flowdesk_g1 -d flowdesk_g1_upgrade -v ON_ERROR_STOP=1 -f apps/api/tests/fixtures/g1-03-upgrade.sql
git archive --format=zip --output=$archive b86b939 prisma
pnpm exec prisma migrate deploy --schema $schema
git archive --format=zip --output=$archive 65a6410 prisma
pnpm exec prisma migrate deploy --schema $schema
psql -X -h 127.0.0.1 -p $fixturePort -U flowdesk_g1 -d flowdesk_g1_upgrade -v ON_ERROR_STOP=1 -f apps/api/tests/fixtures/g1-06-upgrade.sql
pnpm db:migrate
pnpm exec prisma migrate status --schema prisma/schema.prisma

# Initial combined suite
pnpm --filter @flowdesk/api exec vitest run tests/whatsapp-media-echo.integration.test.ts tests/assistant-policy.integration.test.ts tests/paystack-settlement.integration.test.ts tests/payment-relationships.integration.test.ts tests/assistant-router.test.ts tests/assistant-scenarios.test.ts tests/negotiation-gate.test.ts tests/sec-booking-write.test.ts tests/enquiry-led.test.ts tests/send-reply.test.ts tests/sec-autonomy-disclosure.test.ts tests/assistant-delivery-capture.test.ts tests/delivery-authorization.integration.test.ts tests/whatsapp-text-receipts.integration.test.ts tests/paystack-webhook.test.ts tests/billing-subscription-webhook.test.ts tests/payment-integrity.test.ts tests/payment-links.test.ts tests/payment-notifications.test.ts tests/momo-payment-confirmation.test.ts tests/momo-screenshot-claims.test.ts tests/momo-message-processor.test.ts tests/pay-on-request.test.ts tests/order-actor.test.ts tests/order-counts.test.ts tests/wk-pipeline.integration.test.ts tests/webhook-echo.test.ts tests/sec-payout-authorization.test.ts --maxWorkers=1 --minWorkers=1 --testTimeout=30000 --reporter=verbose

# Independent fresh fixture
pnpm --filter @flowdesk/api exec vitest run tests/whatsapp-media-echo.integration.test.ts --maxWorkers=1 --minWorkers=1 --testTimeout=30000 --reporter=verbose

# Isolated G1-05, before other suites leave classifier jobs in this fixture
pnpm --filter @flowdesk/api exec vitest run tests/assistant-policy.integration.test.ts --maxWorkers=1 --minWorkers=1 --testTimeout=30000 --reporter=verbose

# Remaining 27 files, with connection_limit=16 on the disposable database URL
pnpm --filter @flowdesk/api exec vitest run tests/whatsapp-media-echo.integration.test.ts tests/paystack-settlement.integration.test.ts tests/payment-relationships.integration.test.ts tests/assistant-router.test.ts tests/assistant-scenarios.test.ts tests/negotiation-gate.test.ts tests/sec-booking-write.test.ts tests/enquiry-led.test.ts tests/send-reply.test.ts tests/sec-autonomy-disclosure.test.ts tests/assistant-delivery-capture.test.ts tests/delivery-authorization.integration.test.ts tests/whatsapp-text-receipts.integration.test.ts tests/paystack-webhook.test.ts tests/billing-subscription-webhook.test.ts tests/payment-integrity.test.ts tests/payment-links.test.ts tests/payment-notifications.test.ts tests/momo-payment-confirmation.test.ts tests/momo-screenshot-claims.test.ts tests/momo-message-processor.test.ts tests/pay-on-request.test.ts tests/order-actor.test.ts tests/order-counts.test.ts tests/wk-pipeline.integration.test.ts tests/webhook-echo.test.ts tests/sec-payout-authorization.test.ts --maxWorkers=1 --minWorkers=1 --testTimeout=30000 --reporter=verbose

pnpm build
pnpm typecheck
pnpm lint
pnpm test
pnpm --filter @flowdesk/api lint
git diff --exit-code 541b7b8 -- apps/web/src/components/shared/ErrorBoundary.tsx
git diff --exit-code 65a6410 HEAD -- apps/api/src/modules/orders apps/api/src/modules/shipments apps/api/src/modules/billing/billing.route.ts apps/api/src/modules/payments/paystack-receipts.ts apps/api/tests/delivery-authorization.integration.test.ts apps/api/tests/paystack-settlement.integration.test.ts
git diff --check 65a6410 HEAD
```

## Acceptance mapping

| Approved cases | Executed evidence |
| --- | --- |
| 1–7 | Signed image, audio, document, video and sticker events, invalid raw-byte signature, unsupported format, same-identity replay and simultaneous delivery/dispatch. The assertions check durable receipts, message count, archive count and applicable jobs. |
| 8–12 | PostgreSQL trigger rejects admission and rolls back with a retryable response. Redis rejects actual BullMQ writes. The local attachment server times out. Invalid and oversized transfers are quarantined. The object endpoint rejects writes, followed by a successful recovery. |
| 13–14, 24 | Kill the dispatcher before and after message creation, during download, after object write and on either side of queue acceptance. Replay uses one message and one applicable job. The stored-object case removes the provider copy before recovery. |
| 15–18 | Durable and duplicate echoes never queue intent. Receipt-write and echo-message-write failures preserve retryability. Mixed signed batches retain valid siblings and ignore delivery statuses. |
| 19–23 | Unbound, inactive, historically mapped and reassigned phones, provider identity collisions, scoped archive access and monotonic message/customer times. |
| 25–27 | The combined suite includes G1-01 text, G1-05 assistant authority, G1-02 delivery authorization and G1-03/G1-04 payment paths. |

## Repository checks

| Command | Exit | Result |
| --- | --- | --- |
| `pnpm db:generate` | 0 | Generated Prisma Client 5.22.0. |
| `pnpm build` | 0 | Three workspace builds passed. |
| `pnpm typecheck` | 0 | All four Turbo tasks passed. |
| `pnpm lint` | 1 | The inherited web `no-console` error remains at [ErrorBoundary.tsx line 40](../../apps/web/src/components/shared/ErrorBoundary.tsx#L40). The comparison against G0 exited 0. |
| `pnpm --filter @flowdesk/api lint` | 0 | API lint passed. |
| `pnpm test` | 0 | 986 passed, 141 fixture cases skipped by default, zero failed. Web and shared have no test files. |
| `git diff --check 65a6410 HEAD` | 0 | Source diff passed whitespace checks. |
| Targeted `git diff --exit-code 65a6410 HEAD` | 0 | Delivery and Paystack ingress paths and failing legacy tests match the approved baseline. |

## Acceptance runs on the committed source

| Fresh fixture run | Exit | Result |
| --- | --- | --- |
| Empty and seeded upgrade migration, including schema status | 0 for each command | The empty path applied 29 migrations. The upgrade applied G1-06 after the G1-05 baseline. Its assertions confirmed existing text receipt state and historical message data. |
| Initial combined invocation | 1 | 384 passed, 2 failed, zero skipped. All 35 G1-06 cases passed. |
| Independent G1-06 repeat | 0 | 35 passed, zero failed or skipped. |
| Isolated G1-05 invocation | 0 | 28 passed, zero failed or skipped. |
| Remaining 27 files on the isolated fixture | 0 | 358 passed, zero failed or skipped. With the isolated G1-05 invocation, 386 passed. This includes all 35 G1-06, 15 G1-01, 12 G1-02, 35 G1-03, 16 G1-04 and 28 G1-05 cases, plus legacy webhook, echo and message-processing tests. |

## Failure investigation

- The early 30-case development run passed. The next candidate run finished with 383 passed and three failures. The crash fixture was awaiting imports before signaling the before-message boundary and exceeded its startup budget. Moving the pause ahead of heavy imports and giving process startup a separate bounded wait resolved that harness failure. The bodyless classifier fixture stalled while importing or closing a queue consumer. Bodyless media now commits an explicit manual-review disposition before handoff, so this path has no consumer startup or queue dependency. An unchanged G1-02 reassignment test received Prisma `P2028` after the existing 5-second transaction budget. The first committed run passed that G1-02 test.
- The first run of the committed revision passed all 35 G1-06 cases. The overall invocation exited 1 with 384 passed and two failures. The G1-05 OFF test's model spy received eight calls for G1-06 fixtures when its import started a consumer on the shared queue. Running G1-05 first on a fresh queue passed the OFF test and the remaining 27 cases. G1-03 concurrent Paystack admission returned an unexpected retryable 503 during a 12-request burst using Prisma's default interactive transaction budget. That case passed after raising the disposable fixture's connection limit to 16. PostgreSQL showed 13 connections during the burst on the follow-up run. The underlying Prisma error for the first 503 was suppressed by the existing test logger, so the exact failure remains unconfirmed. The branch has no diff in the Paystack receipt writer, webhook route or test.

Live provider hostname and payload variation, live S3-compatible endpoint behavior, production migration lock duration, cutover reconciliation and long-term storage lifecycle are outside the local fixture evidence. Office document bytes, audio transcription, OCR, echo attachment retrieval, provider delivery statuses, and history or app state sync are outside the implementation contract. The approval refers to a Codex Engineering Prompt Book that was unavailable in the checkout and supplied attachments.
