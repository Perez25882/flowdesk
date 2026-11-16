# Batch 4 progress and handoff

The fetched Batch 3 branch and local checkout both pointed to `afac8cd91a656cda62350d55f041a956b356c38a`. Its application and Prisma source matches the founder-approved implementation `c95d50a15308def0ad2d6e9f80faa85f41bbfbac`. The verified Batch 2 ancestor is `0f792ae67341bed49d655115aab0f0c378b875e0`. The preceding [435-test sign-off](../batch-3/closure-report.md) is historical evidence. The `launch` checkout was inspected read-only and contained 44 existing changes.

Active branch `codex/batch-4-service`. Last accepted runtime is Batch 3. The next authorized action is to implement and locally verify Batch 4, then bring the complete result to founder review.

| Component | Disposition | Dependency and verification |
| --- | --- | --- |
| Services, diary and appointment capacity | Extend | Add structured service rules, local hours and global staff and equipment claims. Preserve the existing service and appointment records and historical capacity constraint. |
| Inbound authentication and shared workflow | Retain and extend | Pin Batch 4 service events to a new workflow version. Carry tenant, customer, lead, appointment, invoice and notice identities. |
| Lead qualification | Implement | Capture signed requests, record qualification and outcome, and convert under the booking lock. |
| Checkout, Paystack verification and ledger | Retain and extend | Reuse exact invoice allocation. Gate new checkout on the live booking and preserve independently verified deposits after hold expiry. |
| Outbound and care | Retain and extend | Use the G1 outbox, signed delivery and the existing case lifecycle. Revalidate current appointment and consent at send. |
| Staff work and owner diary | Extend | Reuse role guards and surface configurable reservations, attendance, service evidence and case work. |

The initial profiles cover personal appointments, professional consultations, repair stages, and configured staff-assigned service. A service uses explicit duration, an instant selected from a business-local calendar, one eligible practitioner where required, and one alternative of each configured equipment group. Hold and checkout logic precede staff, care, reminder and browser verification. There is no autonomous travel estimation or external refund. The acceptance report will identify any incomplete workflow explicitly.

## Verification checkpoint

- The first runtime snapshot generated Prisma and passed the full typecheck. On fresh PostgreSQL a 39-migration install, seeded upgrade and restored historical upgrade each exited 0. PostgreSQL backup, restore and historical receipt and payment checks exited 0. This preceded the service invoice SQL guard and dedicated historical appointment fixture.
- The first prior-platform spot regression passed 17 of 19 cases. Two subprocess-based Batch 3 checks failed during a rehearsal with mixed source and compiled output. Their causes require confirmation on rebuilt source.
- The first service-specific candidate passed frozen offline installation, Prisma generation, repository build and typecheck. General tests passed with 991 API and 3 web passes and 199 fixture skips. Lint found one missing return annotation on the new web component. The candidate now includes that annotation.
- The first isolated service suite passed 8 of 9 tests. The remaining journey stopped waiting for provider delivery. The existing outbox recovery applies the signed delivery callback. The corrected fixture executes that step before advancing the workflow.
- The candidate adds process termination and mobile Chromium owner and staff coverage. Run a frozen build followed by all gates. Apply the synthetic historical fixture in `apps/api/tests/fixtures/batch4-preupgrade.sql` after deploying the approved Batch 3 schema and earlier seeds, then exercise the [rollback boundary](service-contract.md#rollback-and-recovery).
