# Batch 3 final completion evidence

**Recommendation — PASS for the documented local Batch 3 scope.** All required local verification gates passed on final implementation `c95d50a15308def0ad2d6e9f80faa85f41bbfbac` on November 16, 2026. Founder review is pending.

The dedicated branch is `codex/batch-3-completion`. It starts from the fetched report commit `cd84165bb50f958971fa7864b549ee1c322888e6`, runtime `4081a34163be1e4e286aa11d70131a1445bba870`, and approved Batch 2 ancestor `0f792ae67341bed49d655115aab0f0c378b875e0`. The [original acceptance report](report.md) remains a historical record. The [completion register](completion.md) and [completion contract](closure-contract.md) document the implementation and boundaries. [ADR 0010](../adr/0010-invoice-allocation-and-return-custody.md) records the authorization and evidence choices.

The initial completion candidate is `80de361cba8f0c7f5d63df6e4e08622fb776469a`. Candidate `3d137184fba731b5a130c070c01eecacb3c4feaf` adds the checkout view guard for stale amounts, wakes reminders when template approval is refreshed and fixes fixture targeting. Final implementation `c95d50a15308def0ad2d6e9f80faa85f41bbfbac` also adds reminder inspection to the order invoice drawer. Verification uses disposable PostgreSQL 17.10, Memurai 8.1.240.0 with BullMQ, loopback Fastify, Node 20.19.0, pnpm 9.12.0, Chromium 157.0.8103.39, and deterministic local Paystack and WhatsApp transports. Live provider accounts, customer data and production systems remain outside this evidence.

## Verification checkpoints

| Check | Exit | Observed result |
| --- | --- | --- |
| Frozen install, Prisma generation, build, typecheck, lint | 0 each | Candidate `80de361`. Offline dependency installation used the frozen repository lockfile. |
| `pnpm test` | 0 | 991 API passes, 189 fixture-gated skips, three web passes. The package with no test files exited successfully. |
| Final frozen install, generation and forced build, typecheck and lint | 0 each | `c95d50a`. Turbo cache was bypassed for workspace tasks. |
| Final `pnpm run test --force` | 0 | 991 API passes, 190 fixture-gated skips, three web passes. Shared has no test files. Turbo cache was bypassed. The integration commands explicitly exercise fixture-gated coverage. |
| Complete G1, Batch 2 and Batch 3 integration on `c95d50a` | 0 and 0 | 31 assistant policy cases and 404 further cases across 32 files. All 435 passed with zero failures and zero skips. Vitest reported 41.79 and 625.98 seconds. |
| Migration and status for empty, Batch 2 and prior Batch 3 databases | 0 each | All three reached 38 migrations. The prior Batch 3 history includes a paid order invoice, exact ledger links and a full return. |
| Initial PostgreSQL backup and restore | 0 each | An independently restored copy preserved the expected historical receipt and payment identities before upgrade. |
| Assistant policy regression | 0 | 31 passes. |
| Complete integration on initial candidate | 0 | 31 assistant cases and 403 additional cases across 32 files. Zero failures and zero skips. The 403-case command took 719.46 seconds. The media saturation case passed in 7.12 seconds. |
| Complete integration before the order reminder display | 0 | 31 assistant cases and 404 additional cases across 32 files. Both commands passed with zero failures or skips on `3d13718`. The 404-case command took 619.11 seconds. |
| Independent fresh-fixture repeat on `c95d50a` | 0 | 59 passes across five files, zero failures and zero skips. Vitest reported 328.12 seconds. The controlled three-request pool exhaustion again logged `P2028` with `DATABASE_POOL_ACQUISITION`. |
| Earlier completion fixture | 1 | Fifteen passes. The capacity fixture failed before its assertion while an intentionally restricted Prisma pool opened its first connection. The final fixture connects first and then deliberately holds the pool's only active slot. |
| Earlier Chromium rehearsals | 1 each | The first fixture attempted to select a catalogue item before opening the item row. The second reached standalone billing after creating the variant and actual order, and after verifying preparation, pickup, support closure and partial return persistence. It stopped on the invoice customer selector. The final fixture opens the catalogue row and scopes the customer selector to the invoice form. |
| `pnpm test --force` shortcut on the closure source | 1 | The package manager rejected the flag before invoking any tests. The explicit package script invocation is `pnpm run test --force`. |
| Final compiled Chromium owner fixture | 0 | The 390 × 844 viewport exercised real product, order, invoice, collection, case, reminder and checkout controls. The owner inspected the order reminder section and the standalone reminder intent. The fixture checked two distinct settled provider requests, a replayed request against the same order, the blocked ambiguous initialization, and tenant isolation after logout and sign-in. |
| Final commerce database backup and restore | 0 each | A restored database retained the connected quote, invoice, preparation and case, the partial-return stock movement and paid standalone request. |
| Compiled smoke, application rollback and roll-forward on completion schema | 0 each | `pnpm smoke:fixture` succeeded on the completion binary, approved Batch 2 binary, previous Batch 3 binary and completion binary again. The current binary reported 53 passes and zero failures on both passes. |

## Operator and journey matrix

| Operator | Completed implementation |
| --- | --- |
| Sales & Orders | Existing inventory-backed offer, variant pricing and explicit signed acceptance. The accepted order still issues one linked invoice and one set of physical stock movements. |
| Payments & Invoices | Standalone and order-linked billing, exact request and settlement identity, verified balances, controlled adjustments, receipts, reload-safe checkout and bounded reminders. |
| Fulfillment & Operations | Verified payment release, packing and production, pickup or shipment, and staff-verified partial or full physical returns with a single stock effect. |
| Customer Care & Retention | Scoped cases, separately recorded refund and exchange obligations, signed closure evidence, opt-out and authorized follow-up. |

The [signed closure fixture](../../apps/api/tests/commerce-completion.integration.test.ts) and [Chromium fixture](../../apps/api/tests/fixtures/batch-commerce-browser.mjs) exercise the handoffs through PostgreSQL, BullMQ, Fastify and the compiled React application.

| Journey | Durable assertions |
| --- | --- |
| Retail and variants | Signed inquiry through shared workflow, exact variant quote, reservation and order, itemized invoice, signed independent financial settlement, staff preparation, physical evidence and signed customer notification. |
| Standalone bills | Owner issue, exact invoice and customer allocation, two separate obligations for one customer, independent provider IDs, partial and final balances, customer-readable receipt, preserved unallocated credit and invoice cancellation. |
| Reminder | Due intent, verified consent and utility template, fresh financial balance, single queue identity after process interruption and eviction, signed delivery, safe late settlement, bounded retries and ambiguity. |
| Interrupted deposit balance | Authenticated callback replay, one provider transaction, exact ledger credit, invoice balance, prepared task and evidence across termination boundaries. |
| Item return | Mixed tracked and custom lines, partial quantity, concurrent replay, refused excess, revoked staff, transaction rollback on movement failure, stock from restockable items, verified custody notice and separate recorded refund or exchange. |
| Custom order | Owner-approved specification, authorized payment, preparation and staff-confirmed pickup through the existing workflow. |
| Customer care | Signed complaint, assigned review and evidence-backed resolution. |
| Browser checkout | Double submit, refresh while provider initialization is pending, original link recovery, repeated order drawer, stale replay, timeout review, two intentional payments, callback during reload, and own-tenant visibility after reauthentication. |
| Tenant and staff | Foreign invoice, reminder and return IDs, wrong customer invoice allocation and provider metadata, current roles and case authority. |
| Media and recovery | Bounded real connection pool saturation, retryable ingress, redacted diagnostics, duplicate convergence, quarantined tenant collision, replay and existing G1 archive and media materialization. |
| Compatibility | Existing G1 and Batch 2 workflows, appointment, authorization, payment settlement, stock and outbound regressions. |

## Reproduction commands

Run these from the frozen source in a short isolated checkout. Use the local Prisma binary built for the installed platform, IPv4 loopback PostgreSQL and Redis or Memurai, and the [Batch 3 fixture procedures](report.md#local-reproduction). The `G1_BATCH_DATABASE_URL` and `G1_BATCH_REDIS_URL` point to the empty database and local cache. `G1_03_UPGRADE_DATABASE_URL` is the seeded Batch 2 upgrade. `G1_B3_UPGRADE_DATABASE_URL` is the independent prior Batch 3 upgrade. Each suite validates it is using local fixtures. Use compiled binaries for the worker termination fixture and set `B2_PLAYWRIGHT` and `B2_CHROMIUM` to the local installed paths for the browser fixture.

```sh
pnpm install --frozen-lockfile --offline
pnpm db:generate
pnpm build --force
pnpm typecheck --force
pnpm lint --force
pnpm run test --force
pnpm db:migrate
pnpm exec prisma migrate status --schema prisma/schema.prisma
pnpm --filter @flowdesk/api exec vitest run tests/assistant-policy.integration.test.ts \
  --maxWorkers=1 --minWorkers=1 --testTimeout=30000 --reporter=verbose
pnpm --filter @flowdesk/api exec vitest run tests/commerce-completion.integration.test.ts \
  tests/whatsapp-media-capacity.integration.test.ts tests/commerce-execution.integration.test.ts \
  tests/workflow-execution.integration.test.ts tests/whatsapp-media-echo.integration.test.ts \
  --maxWorkers=1 --minWorkers=1 --testTimeout=30000 --reporter=verbose
node apps/api/tests/fixtures/batch-commerce-browser.mjs
pnpm smoke:fixture
```

For the complete non-assistant regression command, append `tests/commerce-completion.integration.test.ts` and `tests/whatsapp-media-capacity.integration.test.ts` to the [prior full file list](report.md#local-reproduction). Run the assistant file separately, as in the prior gate. Run the five-file command on a fresh independent cluster for the repeat. The test transport permits local network access and rejects external calls other than the deterministic in-process stubs.

For the Batch 2 upgrade, deploy the historical schemas and seeds in the prior report and run the current migration. For the previous Batch 3 upgrade, restore an independent pre-upgrade Batch 2 dump, apply the archived `4081a34` schema, load `apps/api/tests/fixtures/batch3-completion-preupgrade.sql` using `psql -X -v ON_ERROR_STOP=1 -f`, then apply the final migrations. Query original invoice, linked ledger, workflow and full-return records after upgrading. The verified schema contains 38 migrations. Backup and restore use `pg_dump --format=custom` and `pg_restore --exit-on-error` against separate loopback database names.

## Historical media investigation

The original Batch 3 duplicate-media HTTP 503 has no retained engine exception. Existing admission writes and uniqueness checks return a retryable non-acceptance on transaction failure. The completion code records safe fields for Prisma errors, PostgreSQL SQLSTATE when available, and connection acquisition failure. The deliberate fixture owns one Prisma connection and holds it longer than the admission acquisition window. It checks three signed requests fail without committed receipts, then retries after release and checks one accepted receipt and a quarantined collision in another tenant. The controlled run on `3d13718` logged `P2028` with `DATABASE_POOL_ACQUISITION` for all three failures. The historical failure's exact class remains unknown.

## Financial and recovery evidence

The termination fixture waits for a checkpoint from the actual compiled worker process and then kills it. It uses the same database and cache after each failure and advances only the disposable lease when needed. Before verification and before financial commit, recovery preserves the receipt and creates one exact settled credit later. The deposit case checks that the first GHS 10 remains while the interrupted GHS 40 balance transaction rolls back. After settlement commit, the credit survives without a preparation task. During preparation, the task and workflow transition either both commit or both roll back. The fixture kills before the task and after its uncommitted write, then separately after the joint commit. Each restart checks one preparation task, one settlement transition and unchanged purchased stock.

The reminder fixture kills the scheduler with a retained intent, then kills the outbound poller with the durable send still present before BullMQ scheduling. It removes the queued job, recovers its same identity and consumes matching signed delivery evidence. Separate cases verify the service-window and consent guards, stale-balance suppression, verification of the configured utility template, and ambiguity or retry exhaustion. The financial fixture verifies two same-customer invoice balances and refuses mismatched provider invoice metadata. A PostgreSQL-triggered failure proves that allocation and settlement do not partially commit.

## Source and security checks

The verification checkout matched all 39 changed application and schema paths at `c95d50a`. The patch check passed. The package manifests, dependency lock, workspace configuration and GitHub workflows are unchanged from the authorized parent. A diff scan for private-key blocks and recognizable live provider or automation tokens found zero additions. Fixture guards and the local transport wrapper kept requests on the disposable IPv4 services and synthetic provider handlers. The separate `launch` worktree still contained its 44 pre-existing changes.

## Local operating limits

- Configured transactional utility templates use the supported exact body. Live Meta approval, template deliverability and real Paystack settlement require separate assurance. No provider cost or production capacity is measured here.
- The standalone invoice is an operational GHS document. Jurisdiction-specific legal invoices, tax reporting, autonomous transfers, and automatic external refunds remain outside the supported product contract.
- Physical return custody and verified external payment outcomes are separate. An unsupported disposition remains visible for authorized staff review.
- Binary rollback is for legacy workflows. Keep newly allocated checkout and settlement, reminder producers and return writes quiesced on the prior binary. Earlier clients expect order-linked invoice rows and do not enforce item-level return caps on the full-return route. Resume these operations on the completion binary. The [recovery contract](closure-contract.md#recovery-and-migration) gives the corresponding boundary.
