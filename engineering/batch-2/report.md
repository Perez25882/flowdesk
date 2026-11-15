# Batch 2 engineering report

**Recommendation — BLOCKED pending final fixture verification.** This record is updated as each release command finishes.

## Source and implementation

- Branch `codex/batch-2-execution-platform`. Approved G1 parent `fe411b5541127d172c352e47fa6c67521f2ee3b8`, with verified application `84c92ac0c5c70bad0b6c9d28e7ea15688ef33d4d`.
- The [platform contract](contract.md) contains the architecture diagram, transaction boundaries, operator and connector contracts, policy, owner API and recovery instructions. The [ADR](../adr/0008-shared-workflow-execution.md) records where authority and effects live. The [progress register](progress.md) records the current checkpoint.
- Migration `20261115120000_shared_workflow_execution` adds four tables, two enums and scoped constraints. G1 commercial rows retain their existing schema and authority.
- Opted-in signed WhatsApp text opens a versioned workflow. A purchase reply quoting the real outbound provider message can continue its original quote. Commerce reconciles G1 orders, hosted links, independently verified settlement, shipment state and signed customer delivery. Booking uses the existing availability and reservation service. Support reads scoped order and verified payment facts, then authorizes a constrained outbox action or opens owner review.
- The dashboard has an owner-only work center with history, approval, decline, cancellation, safe retry and preset settings. Authentication uses the existing Fastify and React session contracts. The new outbound claim fences original WhatsApp account ownership, current tenant policy and updated order or payment evidence.

## Verification log

The initial long-path Windows run applied the empty and seeded upgrade schemas. Vitest failed during PostgreSQL connection setup with Prisma P1001. The PostgreSQL server stayed running through that failure. Its log recorded aborted client sockets. The underlying cause was not proved. The short-path workspace reached the same databases using local Prisma engine binaries, so subsequent release runs use the short path.

The first short-path focus run passed 36 of 37 cases and failed the signed journey at appointment fixture setup when no opening hours produced zero slots. The fixture now seeds its schedule. The next focus run passed the combined signed journey and the stale approval and policy-revision cases. Its remaining failure was the crash test's IPC assertion. Node returned the child payload and an undefined handle. The test now asserts the payload and continues to verify the transaction rollback and recovery. No previously passing G1 assertions were removed.

| Gate | Last recorded result |
| --- | --- |
| Frozen installation and Prisma generation | Exit 0 on the short-path workspace. Generation initially encountered a Windows TLS reset before selecting the installed Prisma binaries. |
| Build, typecheck, lint, default tests | Early short-path release candidate returned exit 0. The API passed 991 tests and skipped 169 disposable-fixture cases. The web passed three. Final-source results pending. |
| Empty and synthetic upgrade migrations | Early verification applied and checked 34 migration records with exit 0. Final migration checks pending. |
| Signed commerce, appointment, support, approval and cancellation journeys | Combined manual-checkout fixture passed before the final autonomous checkout test, stronger booking assertions and outbound phone fence. Final candidate pending. |
| PostgreSQL scheduler crash, competing workers and tenant reassignment | Final rerun pending. |
| Full G1 regression, repeated final Batch 2, compiled smoke and backup/restore | Pending. |

## Reproduction

Use a disposable PostgreSQL 17 and Redis or Memurai on IPv4 loopback. Use a short checkout path on Windows, installed Node 20 and pnpm 9, synthetic local provider credentials, and the G1 loopback guard. Run from the repository root.

```sh
pnpm install --frozen-lockfile
pnpm db:generate
pnpm build
pnpm typecheck
pnpm lint
pnpm test
pnpm db:migrate
pnpm exec prisma migrate status --schema prisma/schema.prisma
pnpm --filter @flowdesk/api exec vitest run tests/workflow-execution.integration.test.ts tests/paystack-settlement.integration.test.ts --maxWorkers=1 --minWorkers=1 --testTimeout=30000 --reporter=verbose
pnpm smoke:fixture
```

The direct test command needs the `G1_BATCH_DATABASE_URL`, `G1_BATCH_REDIS_URL`, `G1_03_TEST_DATABASE_URL`, `G1_03_TEST_REDIS_URL` and `G1_03_UPGRADE_DATABASE_URL` loopback fixtures plus the standard test-only API environment. Build first because the process-death test runs the production compiled module. Repeat against newly initialized servers. Use [G1 reproduction](../g1/final-stabilization-report.md#reproduction) for the historical seeds, 28-file regression command, and local setup.

## Scope and limitations

The shared engine observes commercial records committed by the G1 services. It does not attempt payment initialization again during a workflow replay. Booking deposits, reminders, additional connector implementations and generic financial approvals remain outside the supported templates. The only new approval effect is a verified status reply. Staff continue to authorize and execute their existing order, diary and shipment work outside the owner control surface. A late provider event can still reconcile a committed provider intent without reopening a terminal workflow.

The fixture campaign uses only synthetic records and loopback dependencies. Any live-provider behavior, provider billing and hosted deployment remains unverified. Production was not accessed. No deployment or merge was authorized or performed.
