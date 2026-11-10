# G1-01 — Durable WhatsApp text ingress

## Workflow contract

- The API verifies Meta's HMAC over the original HTTP bytes before interpreting the payload. The text parser validates the phone-number ID, provider message ID, sender, timestamp and body per member. Valid text siblings survive invalid inbound members.
- One Postgres transaction inserts normalized text receipts. The unique key is the Meta-specific table plus `(phoneNumberId, waMessageId)`. Repeating that identity preserves the first committed receipt. HTTP 200 `acceptedText` counts supported text items with committed receipts, including duplicates. `enqueued` still reports immediate legacy queue submissions. HTTP 503 with `TEXT_RECEIPT_UNAVAILABLE` means the text batch could not be confirmed durable and should be retried.
- At acceptance a known tenant is pinned, including an inactive tenant. A receiving number assigned to another tenant cannot redirect an existing receipt. An unknown number requires evidence of its owner at delivery before an operator can bind it. A later connection alone is insufficient.
- The in-process worker scans due receipts in bounded batches. It claims each using PostgreSQL `FOR UPDATE SKIP LOCKED`, checks the current tenant mapping under a share lock, and commits the tenant's customer, message and receipt link together. A compatible G0 message can be attached without replacing its text. An incompatible globally unique provider ID is quarantined. Customer activity timestamps only advance.
- A second locked transaction submits the already committed message to the existing BullMQ intent queue. The job ID matches the legacy deterministic ID when valid for BullMQ. IDs containing a colon use a deterministic receipt-based key. The producer fails fast on Redis errors. A crash before enqueue leaves a due receipt. A crash after enqueue can recover the same BullMQ job, or use the linked message's durable `processed` marker if the job has been evicted. Completion records the linked message and successful handoff.
- Completion here means linked message plus accepted classification work, or durable evidence that classification already started. Later AI decisions, order effects and outbound delivery remain the responsibility of the existing downstream workers. Loss of a Redis job **after** a completed handoff and before classification starts is outside the receipt guarantee. Legacy media, echoes and provider status updates are outside the new receipt path.

| State             | Meaning and recovery                                                                                                                                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PENDING`         | Durably accepted and eligible for processing, or waiting to retry a storage operation with `STORAGE_ERROR`.                                                                                                                    |
| `WAITING_MAPPING` | A pinned tenant is inactive or disconnected, or the receipt has no verified owner. The same pinned tenant can resume automatically when active. Unbound receipts wait 24 hours for review, then become `FAILED` if unresolved. |
| `WAITING_QUEUE`   | Message and customer are committed. Redis did not confirm the classification job. The dispatcher retries the same identity.                                                                                                    |
| `FAILED`          | Twelve automatic failures, tenant reassignment, conflicting identity, missing message, stale input or unresolved ownership. Use the reason to decide whether a scoped replay is allowed.                                       |
| `COMPLETED`       | Linked message and classification handoff recorded. Receipt sender, profile, reply ID and body are scrubbed.                                                                                                                   |

Automatic retries start at five seconds and back off to five minutes. There are at most twelve recorded failures per attempt cycle. Worker passes examine up to twenty receipts, with no overlapping pass in one process. A lock releases when its transaction ends or the connection dies. Terminal receipts are pruned after 30 days in batches. Text dated more than 30 days before receipt is acknowledged only with a committed `STALE_EVENT` failure containing no message content. Retention applies to the receipt table. The underlying business message follows existing data policy.

## Migration and rollback

[Migration 20261109090000](../../prisma/migrations/20261109090000_whatsapp_text_receipts/migration.sql) adds one enum, one receipt table, a composite delivery key, a unique optional message link and lookup indexes. The foreign keys use cascade for tenant erasure and set null for message removal. The migration has no backfill and leaves existing message/customer rows in place. The new API requires the additive migration before startup. During a future authorized rollout, drain or isolate pre-migration inbound consumers and cut text intake over to the new version before claiming the receipt guarantee across replicas.

For an incident, set `WHATSAPP_TEXT_DISPATCH_ENABLED=false` and restart the new API under the appropriate authorization. Intake continues to persist receipts while dispatch and pruning are paused. Inspect outstanding rows, resolve the cause and re-enable dispatch. Keep the table, indexes and receipts during application rollback. Quiesce text ingress or keep the durable handler in service during a rollback to the legacy binary, whose webhook has no Postgres acknowledgement guarantee.

## Recovery runbook

Run these steps only on authorized environments. Use the receipt ID and verified tenant ID from the incident, and avoid selecting bodies or sender numbers during triage. A blank `businessId` is an ownership-review record.

```sql
SELECT id, status, reason, attempts, "receivedAt", "nextAttemptAt", "finishedAt", "messageId"
FROM whatsapp_text_receipts
WHERE "businessId" = :'verified_business_id'
  AND status IN ('PENDING', 'WAITING_MAPPING', 'WAITING_QUEUE', 'FAILED')
ORDER BY "receivedAt"
LIMIT 50;
```

- For queue failures, check Redis capacity and reachability and the classifier worker before intervening. Automatic retry is preferred while the receipt has a `nextAttemptAt`.
- For a retryable failed receipt, confirm the original tenant is active and still owns that number, then reset only that receipt. The message link and job identity stay intact. Verify the returned row count and subsequent `COMPLETED` or explicit failure state.
- For an unbound receipt, verify historical ownership at receipt time from an authorized account record before binding. Confirm the exact phone-number ID as well as the tenant. Escalate uncertain ownership, changed owners, message ID collisions and stale events without replaying them.

```sql
UPDATE whatsapp_text_receipts AS r
SET status = 'PENDING', reason = NULL, attempts = 0,
    "finishedAt" = NULL, "nextAttemptAt" = CURRENT_TIMESTAMP
FROM businesses AS b
WHERE r.id = :'receipt_id'
  AND r."businessId" = :'verified_business_id'
  AND r."phoneNumberId" = :'verified_phone_number_id'
  AND b.id = :'verified_business_id'
  AND b."waPhoneNumberId" = r."phoneNumberId"
  AND b.active AND b."deletedAt" IS NULL
  AND r.status = 'FAILED'
  AND r.reason IN ('PHONE_NOT_ACTIVE', 'QUEUE_UNAVAILABLE', 'STORAGE_ERROR')
  AND r.body IS NOT NULL
RETURNING r.id, r.status;
```

After verifying historical ownership, bind only the reviewed unbound receipt.

```sql
UPDATE whatsapp_text_receipts AS r
SET "businessId" = b.id, status = 'PENDING', reason = NULL, attempts = 0,
    "finishedAt" = NULL, "nextAttemptAt" = CURRENT_TIMESTAMP
FROM businesses AS b
WHERE r.id = :'receipt_id'
  AND r."businessId" IS NULL
  AND r."phoneNumberId" = :'verified_phone_number_id'
  AND b.id = :'verified_business_id'
  AND b."waPhoneNumberId" = r."phoneNumberId"
  AND b.active AND b."deletedAt" IS NULL
  AND r.status IN ('WAITING_MAPPING', 'FAILED')
  AND r.reason = 'PHONE_OWNER_UNVERIFIED'
  AND r.body IS NOT NULL
RETURNING r.id, r.status;
```

See the [verification record](verification.md) for the fixture commands and results.
