# FlowDesk Batch 1 engineering verification

This report records the earlier Batch 1 snapshot. The [G1 final stabilization assessment](final-stabilization-report.md) covers the subsequent runtime and fixture changes.

**Recommendation: BLOCKED for full Batch 1 sign-off.** The clean verification foundation, full regression and local release rehearsal passed. One fresh repeat routed the synthetic retail inquiry to review before committing a quote. The subsequent focused run passed, and the original triggering error remains unverified. Keep the automatic retail path under review until a repeatable cause and disposition are established.

## Source and scope

| Item | Source |
| --- | --- |
| Integration branch | `codex/g1-batch-1` |
| Founder-approved baseline | `e4a4021b977a3c843b1e76f5a140827e05eaf593` |
| Full regression, clean build, smoke and rollback source | `7e4c434d1e5cb04f90833cbeb438a9c5f9afb614` |
| Retail replay diagnostics | `e7a0d941cc9161b3e14c6d8f2a09969210a52cfa` |
| Expanded journey snapshots | `de295dd7be6c985de5b1c8c39f9901b190938001` and `c3d77a3005381836d4e5b5379f2b68714195ca26` |

The last changes after the runtime snapshot add or extend tests, update isolated CI configuration and record engineering evidence. See the [architecture and operational contracts](batch-1-contract.md), [ADR 0007](../adr/0007-batch-1-execution-recovery.md), [G0 defects](../g0/defects.md), and [progress register](batch-1-progress.md).

## Workstream evidence

| Workstream | Implementation | Acceptance evidence and limits |
| --- | --- | --- |
| G1-00 | Restored frontend lint. Updated invitation, trial, credential failure and environment smoke assertions. Added disposable service configuration, migrations and workspace-order build in CI. | Clean archive installation, typecheck, build and lint executed. Hosted GitHub Actions status requires independent confirmation. |
| G1-07 | Existing rule and assistant order paths share durable source identity, scoped locks and atomic source linkage. Booking uses a source-row lock with existing uniqueness and slot exclusion. Classifier polling recovers evicted handoffs. Manual ledger writes accept an optional request key. | Concurrent writes, rollback before source commit, replay, stale policy, wrong customer, evicted queue job and competing reservations are tested. A failed Redis conversation mutex sends the turn to review. |
| G1-08 | Durable tenant-scoped intents and a distinct provider evidence state machine, transactional draft approval, queue recovery and signed status reconciliation. | Synthetic acceptance, permanent rejection, ambiguous timeout, real worker death, evicted job, Redis write refusal, duplicate and early/reordered status, wrong tenant phone or recipient and owner takeover before provider I/O are exercised. |
| G1-09 | Order transition, shipment metadata, history and handoff commit together. A staged proof is cleaned through a bounded durable task. | Assigned-rider and owner flows, object faults, concurrent reassignment, proof access, atomic rollback, idempotent completion and resumed notification work exercised. |
| G1-10 | Local browser gateway, dependency readiness, additive migration and documented rollback procedure. | Empty and historical upgrades, backup and restoration executed. See command and release evidence below. |

## Paystack 503 and classifier investigations

The early full run repeated the original 503 on concurrent signed merchant callbacks. That assertion had no database code attached. On the former interactive admission path, deliberately occupying the exact Prisma connection pool reproduced a 503 with `P2028`. No receipt was acknowledged or persisted. Replaying the identical signed bytes after releasing capacity produced one durable receipt and one settlement. This establishes a recoverable capacity failure in the old path. The exact code attached to the original intermittent response remains unverified.

The corrected path resolves the merchant reference and commits the receipt in one parameterized statement. Its unique event key fences identical deliveries. The new saturation control checks `P2024` and the same 503, zero receipt before retry and one settlement after retry. The regular concurrency test requires 12 HTTP 200 responses, five distinct receipt records and one settlement, and reports safe database codes if the assertion fails.

An ingress receipt can now retain a due classifier check after BullMQ handoff. The real Redis test removes the deterministic job, runs competing recovery passes, confirms redispatch, then commits processed evidence in PostgreSQL and verifies the check clears. The earlier assertion assumed its receipt would always fall inside a bounded global scan. The revised test runs the same bounded passes as the production scheduler.

## Database and rollout

| Migration | Additive change |
| --- | --- |
| `20261114170000_inbound_commercial_identity` | Unique optional inbound order source, classifier recovery schedule, tenant-scoped manual payment request identity and request fingerprint. |
| `20261114180000_durable_outbound` | Durable WhatsApp send records and signed normalized provider delivery receipts. |
| `20261114190000_fulfillment_recovery` | Durable fulfillment notification and private proof cleanup records. |

The release rehearsal uses PostgreSQL 17 and Memurai running on independent IPv4 loopback ports. BullMQ uses the disposable Redis-compatible instance. The clean archive uses Node 20.19.0 and pnpm 9.12.0. Test providers use synthetic responses or loopback servers. The tests do not use provider accounts, customer credentials or production systems.

## Reproduction

Run the [fixture instructions](batch-1-contract.md#verification) from an archive of the tested source. Use clean `node_modules` for the first install. Configure synthetic signing keys and disposable database and Redis URLs, with no application dotenv file. Run static checks before setting fixture-specific variables if reporting default-test skips.

```sh
pnpm install --frozen-lockfile
pnpm db:generate
pnpm build
pnpm typecheck
pnpm lint
pnpm test
pnpm db:migrate
pnpm exec prisma migrate status --schema prisma/schema.prisma
pnpm smoke:fixture
```

For PostgreSQL/BullMQ regression, set fixture variables as follows. Each URL points at an isolated localhost service. Put the historical fixture rows in a separate database. Use the seeded database only for the upgrade variables.

| URLs | Variables |
| --- | --- |
| Operational fixture PostgreSQL | `DATABASE_URL`, `DIRECT_URL`, `G1_TEST_DATABASE_URL`, `G1_BATCH_DATABASE_URL`, `G1_02_TEST_DATABASE_URL`, `G1_03_TEST_DATABASE_URL`, `G1_04_TEST_DATABASE_URL`, `G1_05_TEST_DATABASE_URL`, `G1_06_TEST_DATABASE_URL` |
| Operational fixture Redis | `REDIS_URL`, `G1_TEST_REDIS_URL`, `G1_BATCH_REDIS_URL`, `G1_02_TEST_REDIS_URL`, `G1_03_TEST_REDIS_URL`, `G1_04_TEST_REDIS_URL`, `G1_05_TEST_REDIS_URL`, `G1_06_TEST_REDIS_URL` |
| Historical synthetic PostgreSQL | `G1_03_UPGRADE_DATABASE_URL`, `G1_04_UPGRADE_DATABASE_URL`, `G1_06_UPGRADE_DATABASE_URL` |

The test launcher applies each historical revision using `git archive <revision> prisma` and `pnpm exec prisma migrate deploy --schema <archive>/prisma/schema.prisma`. Apply `3881366` and `apps/api/tests/fixtures/g1-04-upgrade.sql`, then apply `8648d31` and `g1-03-upgrade.sql`, then apply `b86b939`, `65a6410`, and `g1-06-upgrade.sql`, then apply `e4a4021`. Execute SQL seed files with `psql -X -v ON_ERROR_STOP=1 -f <fixture>`. Apply the three Batch 1 migrations with `pnpm db:migrate`. Run the assistant suite first so an automatically started legacy test worker has no earlier classifier jobs to consume.

```sh
pnpm --filter @flowdesk/api exec vitest run tests/assistant-policy.integration.test.ts --maxWorkers=1 --minWorkers=1 --testTimeout=30000 --reporter=verbose
pnpm --filter @flowdesk/api exec vitest run \
  tests/whatsapp-media-echo.integration.test.ts tests/batch-reliability.integration.test.ts \
  tests/paystack-settlement.integration.test.ts tests/payment-relationships.integration.test.ts \
  tests/assistant-router.test.ts tests/assistant-scenarios.test.ts tests/negotiation-gate.test.ts \
  tests/sec-booking-write.test.ts tests/enquiry-led.test.ts tests/send-reply.test.ts \
  tests/sec-autonomy-disclosure.test.ts tests/assistant-delivery-capture.test.ts \
  tests/delivery-authorization.integration.test.ts tests/whatsapp-text-receipts.integration.test.ts \
  tests/paystack-webhook.test.ts tests/billing-subscription-webhook.test.ts \
  tests/payment-integrity.test.ts tests/payment-links.test.ts tests/payment-notifications.test.ts \
  tests/momo-payment-confirmation.test.ts tests/momo-screenshot-claims.test.ts \
  tests/momo-message-processor.test.ts tests/pay-on-request.test.ts tests/order-actor.test.ts \
  tests/order-counts.test.ts tests/wk-pipeline.integration.test.ts tests/webhook-echo.test.ts \
  tests/sec-payout-authorization.test.ts --maxWorkers=1 --minWorkers=1 --testTimeout=30000 --reporter=verbose
```

For repeated crash, concurrency, storage and Paystack coverage, run the same flags with `tests/batch-reliability.integration.test.ts`, `tests/delivery-authorization.integration.test.ts`, `tests/paystack-settlement.integration.test.ts`, and `tests/whatsapp-text-receipts.integration.test.ts` on fresh fixtures.

## Executed results

The first full candidate run had two failures in the 28-suite command, with 367 passing. The assistant pass was 28/28. Another candidate run had 372 passing with two failures, one bounded global Redis recovery assertion and one child startup deadline. A focused follow-up with runtime snapshot `1cf8148` passed all 78 tests in four files. The earlier clean build failures were candidate TypeScript errors from strict optional-field and tuple inference. The later runtime snapshot corrected both.

The clean archive of `7e4c434` returned exit 0 for `pnpm install --frozen-lockfile`, `pnpm db:generate`, `pnpm build`, `pnpm typecheck`, `pnpm lint` and `pnpm test`. The default test command passed 991 tests in 75 files and skipped 159 fixture-dependent tests in seven files. An earlier deep Windows archive returned exit 1 on two test-suite imports under a 285-character pnpm Sentry dependency path. The shorter clean archive used the same dependency lockfile and collected both suites successfully.

The exact clean archive of `7e4c434` returned exit 0 for `pnpm db:migrate` and `pnpm smoke:fixture`. The smoke runner passed 53 checks, served the compiled SPA for a deep link, preserved the JSON API 404 and received API shutdown exit 0. The synthetic revoked-token log was expected.

The full PostgreSQL/BullMQ regression on `7e4c434` returned exit 0 for both Vitest commands. It passed 29 assistant cases and 375 other cases in 28 suites with zero failures or skips. Both migration deploys and both `prisma migrate status` runs returned exit 0. The fresh database applied 32 migrations. The upgrade applied three Batch 1 migrations after the seeded G1-06 source. `pg_dump --format=custom`, `createdb`, `pg_restore --exit-on-error` and the verification query returned exit 0. The restored historical database contained the pending WhatsApp receipt and the synthetic historical paid request.

Earlier runs had a child startup timeout and, in the retail suite, a timeout and a failed attempt to allocate the test's full pool concurrently. The final crash fixture loads the compiled worker directly, reports progress before provider I/O and kills the child only after confirming a durable `SENDING` row. The saturation fixture acquires and fences each held connection before calling the signed endpoint.

A later four-suite repeat recorded 78 passing tests and one retail failure, exit 1. SQL inspection of that disposable database confirmed the inquiry was classified and durably held in `REVIEW` with `effect_unavailable`. There was no recorded model result or grounded quote intent. The last test-only update captures the safe assistant error type if that path recurs and uses a ten-second Prisma pool timeout for the fixture.

On fresh fixtures at `e7a0d94`, `pnpm --filter @flowdesk/api exec vitest run tests/paystack-settlement.integration.test.ts --maxWorkers=1 --minWorkers=1 --testTimeout=30000 --reporter=verbose` returned exit 0 with 37 passing tests and zero skips. The retail inquiry and the deterministic pool-saturation and exact-retry control both passed. The last test-only change leaves the tested runtime binaries identical. The earlier retail failure remains open.

### Local binary rollback and restore

`git archive e4a4021b977a3c843b1e76f5a140827e05eaf593` was built in a separate short-path checkout. Its `pnpm install --frozen-lockfile`, `pnpm db:generate` and `pnpm exec turbo run build --filter=@flowdesk/api` commands returned exit 0. The long-path archive previously failed its runtime import with `ERR_MODULE_NOT_FOUND` for the same Sentry dependency path as the long-path general tests.

The final rehearsal deployed the 29 baseline migrations with `pnpm exec prisma migrate deploy --schema <G1-06 archive>/prisma/schema.prisma`, exit 0. The Batch 1 executable `node --import <synthetic preload> apps/api/dist/server.js` refused to boot on that schema with exit 1 and PostgreSQL `42P01` for the missing fulfillment table. After `pnpm db:migrate` returned exit 0, a single synthetic SQL seed inserted an attested payment, its request, a settled Paystack receipt and settlement, and an outbound send in review.

With ingress paused, the Batch 1 binary, G1-06 binary and Batch 1 binary each returned JSON readiness and exited 0 through the graceful shutdown handler. The SQL evidence query returned exit 0 and verified the settled receipt, the settlement's exact payment link and the outbound review state. `pg_dump --format=custom` and `pg_restore --exit-on-error` returned exit 0. The same query passed in the newly restored database. Each process was run with the disposable DSN, a synthetic preload and a local health probe. This rehearsal retains the additive schema across the binary switch and preserves post-upgrade writes.

## Workflow demonstration

| Journey | Evidence from the named integration tests | Boundary |
| --- | --- | --- |
| Retail sale | A signed WhatsApp inquiry produces a server-priced GHS 25 quote and synthetic Meta acceptance. A signed purchase creates the linked GHS 25 order. Synthetic hosted checkout, authenticated Paystack confirmation, ledger credit, owner dispatch and delivery completion produce one customer notification accepted by synthetic Meta. | The fixture uses grounded AI for the inquiry and selects rule-based purchase intake for the second turn. It drives the classifier handler after receipt handoff. The G1-01 suite separately exercises the real BullMQ handoff. |
| Booking | A real service roster exposes a slot. Competing assistant bookings leave one appointment and one confirmation send for the winner. Replaying the source returns the existing appointment. Cancellation restores availability and permits a second booking. | Booking deposit and scheduled reminders are future dependencies. |
| Human escalation | An unsupported refund assertion enters review. A delivery rider cannot reply. An authorized manager's human reply becomes a durable send, receives synthetic provider acceptance and reconciles signed delivery evidence. | The model and provider transport are synthetic. |
| Recovery | Real subprocess interruption around text queueing, Paystack verification and financial commit, and an outbound provider attempt. A real PostgreSQL trigger denies source linkage and an injected constraint denies fulfillment notification insertion. Replay recovers one committed effect. An already committed shipment has a pending notification task and recovery hands it off. | Order and fulfillment pre-commit coverage uses transaction failure injection. The post-commit fulfillment test resumes durable work directly. |
| Tenant and staff isolation | Cross-tenant and guessed shipment IDs expose no proof or mutation; same-tenant unassigned riders fail. Reassignment races recheck the locked row. Inbound ID collisions, cross-tenant Paystack transaction identity, stale draft authority and wrong outbound recipient are covered. | Tests use several independently seeded synthetic tenant pairs. |
| Mixed inbound events | Real signed batches isolate malformed siblings, deduplicate and persist text, media and echoes. Separate injected Redis refusal and process deaths confirm recovery; tenant phone ownership remains pinned. | Media and storage are synthetic. No live Meta payload formats were inferred from this run. |

## Release blockers and limitations

| Release condition | Evidence or follow-up |
| --- | --- |
| Retail inquiry replay stability | The focused repeat recorded durable review without a model result or price response. The exact triggering error is unverified. |
| Live provider validation | Validate Meta coexistence, opaque status correlation, approved templates, throttling, Paystack merchant verification, and S3 private-object behavior in founder-authorized staging. An ambiguous send without corroborating evidence stays in review. |
| Hosted release validation | Confirm the deployed same-origin proxy, startup and drain behavior, secret injection, and staging backup policy. The tracked Vercel fallback excludes API paths. Hosted API upstream routing remains a deployment requirement. |
| Mixed-version boundary | Pause ingress and drain or explicitly quarantine legacy outbound jobs before changing versions. The old Redis payload consumer remains for compatibility and runs without a PostgreSQL send intent. Operate one execution version at a time. |
| Later operator scope | Booking confirmation is supported. Appointment deposits and scheduled reminders require future operator work. |
| Manual-entry client retry | API clients may send the optional idempotency header. The existing UI submits independent manual entries without that header. |
| Owner stock alerts | Customer fulfillment status has durable handoff. An owner low-stock alert is emitted after commit and can be lost if the process stops before it creates a send intent. |
