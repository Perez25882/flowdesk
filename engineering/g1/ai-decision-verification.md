# G1-05 verification

**Recommendation** PASS for local acceptance on 2026-11-13. Founder sign-off is pending.

The implementation revision is `3076dd8fcd988c6acb7124ed076be2a62c1bcb6f` on `codex/g1-05-evidence-gated-ai`. It starts from founder-approved G1-03 revision `b86b939378a151795c934aacb7bed394b5330a5d`. The baseline and implementation commits were clean. The final runs used the committed source and a documentation-only verification draft.

## Fixtures and commands

The synthetic acceptance runs start separate disposable PostgreSQL 17.10 clusters and Redis-compatible Memurai instances bound to IPv4 loopback. The fixture clears inherited provider credentials and blocks non-loopback Node sockets and fetches. The real assistant client parses deterministic model output, and the checkout case uses a synthetic Paystack response. Prisma, Fastify worker/service modules, the tenant records and BullMQ queues use their local implementations. The fixture never contacts a real provider or production system.

Set `G1_05_TEST_DATABASE_URL`, `G1_04_TEST_DATABASE_URL`, `G1_03_TEST_DATABASE_URL`, `G1_02_TEST_DATABASE_URL` and `G1_TEST_DATABASE_URL` to the disposable fresh database. Set the corresponding `*_TEST_REDIS_URL` variables to the run's disposable cache, and `G1_03_UPGRADE_DATABASE_URL` and `G1_04_UPGRADE_DATABASE_URL` to the synthetic upgrade database. The first `db:migrate` uses the empty database. The subsequent archive/deploy/seed sequence uses the upgrade database. `$schema` refers to the extracted `prisma/schema.prisma` for the immediately preceding revision. Root checks use `CI=true` and `NODE_ENV=test` without integration opt-in variables.

```powershell
pnpm --filter @flowdesk/shared build
pnpm db:generate
pnpm db:migrate
pnpm exec prisma migrate status --schema prisma/schema.prisma
git archive --format=zip --output=$archive 3881366 prisma
pnpm exec prisma migrate deploy --schema $schema
psql -X -h 127.0.0.1 -p $fixturePort -U flowdesk_g1 -d flowdesk_g1_upgrade -v ON_ERROR_STOP=1 -f apps/api/tests/fixtures/g1-04-upgrade.sql
git archive --format=zip --output=$archive 8648d31 prisma
pnpm exec prisma migrate deploy --schema $schema
psql -X -h 127.0.0.1 -p $fixturePort -U flowdesk_g1 -d flowdesk_g1_upgrade -v ON_ERROR_STOP=1 -f apps/api/tests/fixtures/g1-03-upgrade.sql
git archive --format=zip --output=$archive b86b939 prisma
pnpm exec prisma migrate deploy --schema $schema
pnpm db:migrate
pnpm exec prisma migrate status --schema prisma/schema.prisma
pnpm --filter @flowdesk/api exec vitest run tests/assistant-policy.integration.test.ts tests/paystack-settlement.integration.test.ts tests/payment-relationships.integration.test.ts tests/assistant-router.test.ts tests/assistant-scenarios.test.ts tests/negotiation-gate.test.ts tests/sec-booking-write.test.ts tests/enquiry-led.test.ts tests/send-reply.test.ts tests/sec-autonomy-disclosure.test.ts tests/assistant-delivery-capture.test.ts tests/delivery-authorization.integration.test.ts tests/whatsapp-text-receipts.integration.test.ts tests/paystack-webhook.test.ts tests/billing-subscription-webhook.test.ts tests/payment-integrity.test.ts tests/payment-links.test.ts tests/payment-notifications.test.ts tests/momo-payment-confirmation.test.ts tests/momo-screenshot-claims.test.ts tests/momo-message-processor.test.ts tests/pay-on-request.test.ts tests/order-actor.test.ts tests/order-counts.test.ts tests/wk-pipeline.integration.test.ts tests/webhook-echo.test.ts tests/sec-payout-authorization.test.ts --maxWorkers=1 --minWorkers=1 --testTimeout=30000 --reporter=verbose
pnpm --filter @flowdesk/api exec vitest run tests/assistant-policy.integration.test.ts --maxWorkers=1 --minWorkers=1 --testTimeout=30000 --reporter=verbose
pnpm --filter @flowdesk/api exec vitest run tests/wk-reply-and-intent-correction.test.ts --maxWorkers=1 --minWorkers=1
pnpm build
pnpm typecheck
pnpm lint
pnpm test
pnpm --filter @flowdesk/api lint
git diff --check b86b939 HEAD
git diff --exit-code 541b7b8 -- apps/web/src/components/shared/ErrorBoundary.tsx
git status --short --branch
```

## Scope of evidence

- The assistant suite covers all four modes, typed quotes, stock and price freshness, missing products, unauthorized discounts, false payment and refund claims, customer and tenant scoping, delivery promises, unavailable and concurrent bookings, permission changes, prompt injection, malformed/conflicting proposals, provider failure, and normal replies and clarification. The queue and data assertions check that rejected material proposals do not produce unauthorized messages or domain effects.
- Real service tests assert exact order totals, source-message idempotency, same-customer attested ledger balances, a verified checkout amount, appointment uniqueness and an owner approval with fresh evidence. Stale, legacy, cross-tenant and unauthorized staff approvals are rejected. Worker replay and direct business-service replay are exercised.
- The initial real-fixture run exited 1 before assertions because the disabled legacy NVIDIA classifier still required a key during module construction. A synthetic key fixed fixture setup while model traffic stayed mocked. A development run then passed all 24 cases. The first combined passing run covered 349 cases, and its independent run covered 26. Later verification added permission-change, contradictory-order and ambiguous-checkout coverage. The checkout correction requires a specific eligible order and holds a generic request if multiple eligible orders exist.
- The first full repository test run failed five human-reply tests. Their in-memory fixtures lacked the staff lookup and customer ownership fields required by the service. The final revision supplies those fixtures and keeps the original human queue call free of an idempotency option. Explicit assistant approval retains its deterministic queue identity. The focused rerun passed all 10 human-reply and intent-correction tests.

The [authority contract](ai-decision-contract.md), [source inventory](ai-trust-boundaries.md) and [architecture decision](../adr/0005-assistant-authority.md) record the boundaries. The separately named Codex Prompt Book was unavailable. Live model quality, provider delivery, production migration lock duration and human reconciliation of ambiguous stopped turns remain unverified. Orders pending owner confirmation do not reserve inventory. The existing messaging and provider delivery recovery milestones remain separate.

## Repository checks

| Check | Exit | Evidence |
| --- | --- | --- |
| `pnpm --filter @flowdesk/shared build` and `pnpm db:generate` | 0 / 0 | Shared contract built and Prisma Client 5.22.0 generated. |
| Empty migration and status | 0 / 0 | All 28 migrations applied in both final fixture runs. |
| Upgrade archives, deploys, seeds and status | 0 each | Synthetic G1-02 and G1-04 history loaded, G1-03 baseline applied, and the additive G1-05 migration applied on top. |
| Combined integration and regressions | 0 | 351 passed across 27 files, zero failed or skipped. Includes 28 G1-05, 35 G1-03, 16 G1-04, 12 G1-02 and 15 G1-01 cases. |
| Independent G1-05 repeat | 0 | 28 passed, zero failed or skipped, on a new PostgreSQL and Redis pair. |
| `pnpm build` | 0 | Workspace build passed. |
| `pnpm typecheck` | 0 | Workspace typecheck passed. |
| `pnpm lint` | 1 | Inherited web `no-console` error at `ErrorBoundary.tsx:40`. The comparison to G0 exited 0. |
| `pnpm test` | 0 | 986 passed across 73 files, zero failed. The combined integration command ran all 106 opt-in cases skipped by this command. The default suite has one fewer test than G1-03 because the old nullable `settleBooking` no-op is no longer an entry point. |
| `pnpm --filter @flowdesk/api lint` | 0 | No API lint failures. |
| Focused human-reply regression | 0 | 10 passed. |
| `git diff --check b86b939 HEAD` | 0 | Implementation diff passed whitespace checks. |
