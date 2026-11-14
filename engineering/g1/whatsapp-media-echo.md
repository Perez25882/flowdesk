# G1-06 durable WhatsApp media and echo workflow

The [source inventory](whatsapp-event-inventory.md) records the approved G1-05 starting point. The [architecture decision](../adr/0006-whatsapp-media-echo.md) extends the [G1-01 text contract](whatsapp-text-ingress.md) with media, echoes and the existing interaction types.

## Admission and identity

Fastify verifies the Meta HMAC against the original bytes. A bad signature returns 401. Invalid JSON or an invalid WhatsApp envelope returns 400. A signed envelope with structurally valid changes processes each recognized member independently. Status callbacks and unknown fields have no business effects. A valid envelope without any supported valid members returns 200 with zero accepted events.

PostgreSQL commits all supported valid members in one transaction before HTTP 200. Transaction failure returns 503 for provider retry. The response counts supported members including known duplicates. `acceptedMedia`, `acceptedEchoes` and `acceptedInteractions` appear when nonzero. The existing text acknowledgment shape is preserved. `enqueued` and `echoed` are zero because the dispatcher performs those steps later.

The receipt key is `(phoneNumberId, waMessageId)`. The first durable receipt wins on replay. A transaction-level advisory lock serializes admission by provider message ID and orders locks across mixed batches. A receipt under another phone with the same provider ID is quarantined with `MESSAGE_ID_COLLISION`. The global unique message key, tenant, direction, type and customer checks also protect against existing legacy rows or replays after receipt retention. The dispatcher uses the original event timestamp for the message and advances customer activity only when the event is newer. Business echoes never advance `lastInboundAt`.

## Ownership and threat boundaries

PostgreSQL records phone ownership intervals on business connection changes, disconnection, soft deletion and deletion. New receipts pin the sole ownership interval observed at the event timestamp. Migration seeds the currently configured tenant from migration time. Existing unfinished G1-01 receipts already pinned to that same tenant attach to the seeded interval. The trigger cannot establish earlier unrecorded ownership. If a timestamp's second overlaps two intervals, the receipt requires review. An unbound receipt never acquires a tenant from a later connection. A historically known but ended association cannot dispatch under a replacement connection, even when the original tenant later reconnects.

Phone IDs, provider IDs and recipient identities come from the signed Meta envelope. An echo must be in `smb_message_echoes.message_echoes[]` and have valid sender and recipient identities. The sender must match any supplied metadata display number and the tenant's configured WhatsApp display identity when present. An echo commits its outbound business-app message and receipt together. It never enters the classifier or outbound sender. Owner and staff send authorization still uses the existing role contract. The conversation uses the echo to recognize that a human replied.

Media resolution uses the pinned tenant's token, the exact phone ID and the Meta Graph media lookup. A provider URL must be HTTPS under `lookaside.fbsbx.com/whatsapp_business/attachments/`. Redirects are refused. A message caption, filename, URL or MIME declaration cannot select a network destination. The worker checks the allowlist, signatures, size and any available authenticated digest. These are format checks, not malware scanning. Requests and downloads are bounded to 12 seconds overall. Object writes are bounded to 10 seconds. The worker stores data in the configured private bucket under a tenant namespace and a deterministic hash of phone and provider message IDs.

Authorized users with `messages.read` can request verified G1-06 media at `GET /api/v1/messages/:id/media`. The service scopes the message and customer to the requester’s business and recomputes the expected key. The response is a private, uncached attachment. Legacy payment screenshot access uses the payment capability and tenant storage prefix. Provider tokens, retrieval URLs and raw payloads are excluded from receipt state and failure logs.

## Supported events

| Event | Local behavior |
| --- | --- |
| Text, button, interactive button/list, reaction | Durable inbound conversation linkage and existing classifier handoff. Reaction emoji and target are retained on the message. |
| Image | JPEG and PNG up to 5 MiB. Caption can enter the existing classifier. The existing MoMo metadata heuristic may queue a claim for review. The claim contributes zero credited amount. |
| Audio | AAC, AMR, MPEG, MP4 and Opus in Ogg up to 16 MiB. A bodyless message goes to review with `MEDIA_ANALYSIS_UNSUPPORTED` and no automated intent. |
| Document | PDF or UTF-8 plain text up to 100 MiB. The caption is the only classifier input. Office formats are retained as receipts for review with `MEDIA_UNSUPPORTED`. |
| Video and sticker | MP4 or 3GPP video up to 16 MiB, WebP sticker up to 500 KiB. The worker archives the bytes. A supported caption may enter the classifier. |
| Business-app echo | Outbound conversation entry with applicable caption and type. Echo attachment bytes are outside the existing echo workflow. |
| Other provider events | Delivery statuses belong to G1-08. History synchronization, app-state sync, location, contact and unrecognized interactive variants have no G1-06 business handler. |

Audio transcription, document parsing, OCR and video or sticker analysis are outside this contract. For supported inbound media, a failed download or archive cannot trigger automated classification. Compatible pre-cutover image rows can retain their historical archive and payment claim key. Their existing payment screenshot route still owns access.

## States and completion

| State | Evidence and action |
| --- | --- |
| `PENDING` | Committed normalized event awaits linkage or experienced retryable `STORAGE_ERROR`. Customer and message linkage use a single transaction. |
| `WAITING_MAPPING` | `PHONE_NOT_ACTIVE` can resume for the same pinned interval. `PHONE_OWNER_UNVERIFIED` waits 24 hours for investigation and becomes failed without automatic rebinding. |
| `WAITING_MEDIA` | A bounded download, tenant credentials, object storage or media finalization failed. The linked message stays reviewable with a safe reason. A 60-second persisted lease fences competing workers. |
| `WAITING_QUEUE` | The inbound message and applicable archive are committed. Retry the deterministic BullMQ handoff without repeating the archive. |
| `COMPLETED` | Inbound events have a linked tenant message and applicable archive, with either a BullMQ handoff or a durable message disposition. Bodyless media sets `MEDIA_ANALYSIS_UNSUPPORTED` for human review without classifier submission. The echo's outbound message and receipt complete in the same PostgreSQL transaction. Completion clears the normalized receipt body, sender, media ID, digest and supplemental payload. |
| `FAILED` | Review the safe reason. Invalid media, ownership change, identity collision, missing message, sender mismatch and timestamps outside the horizon are quarantined. An expired Meta media ID needs a customer resend if no committed archive can be recovered. |

The shared worker drains up to 20 non-media receipts per pass. A separate polling lane drains up to two media receipts per pass so provider waits leave the text and echo lane available. Polling resumes one second after a pass. Each transient failure backs off from 5 seconds up to 5 minutes, with a 12-attempt cap. Twelve media claims also cap repeated process deaths. A retry after an interrupted object write checks the private object’s bounded type, size and stored digest against the digest from the original signed payload. Without that signed digest it re-fetches Meta. Queue handoff records no claim about later classification, order creation, booking, sending or delivery.

## Recovery and retention

The existing worker startup starts both receipt polling lanes. After dependency recovery it resumes due receipts. Operators can inspect counts by state and reason without reading customer payloads.

```sql
SELECT kind, status, reason, count(*)
FROM whatsapp_text_receipts
WHERE "businessId" = :'business_id'
GROUP BY kind, status, reason;
```

For an exhausted transient receipt, restore the dependency first. Confirm the exact receipt, original tenant, phone mapping and live ownership interval. Run the following with a tenant-scoped operational session, check that exactly one row changed, then verify the worker's message link, archive evidence and handoff.

```sql
UPDATE whatsapp_text_receipts r
SET status = 'PENDING', reason = NULL, attempts = 0, "mediaClaims" = 0,
    "nextAttemptAt" = timezone('UTC', now()), "finishedAt" = NULL,
    "leaseToken" = NULL, "leaseUntil" = NULL
FROM whatsapp_phone_ownership o, businesses b
WHERE r.id = :'receipt_id' AND r."businessId" = :'business_id'
  AND r.status = 'FAILED' AND r.sender IS NOT NULL
  AND r.reason IN ('PHONE_NOT_ACTIVE', 'QUEUE_UNAVAILABLE', 'STORAGE_ERROR', 'MEDIA_TIMEOUT',
      'MEDIA_PROVIDER_UNAVAILABLE', 'MEDIA_CREDENTIALS_UNAVAILABLE', 'MEDIA_STORAGE_UNAVAILABLE',
      'MEDIA_PROCESSING_FAILED', 'MEDIA_LEASE_RETRY_LIMIT')
  AND r."sentAt" >= timezone('UTC', now()) - interval '30 days'
  AND r."receivedAt" >= timezone('UTC', now()) - interval '30 days'
  AND o.id = r."ownershipId" AND o."businessId" = r."businessId"
  AND o."phoneNumberId" = r."phoneNumberId" AND o."endedAt" IS NULL
  AND b.id = r."businessId" AND b."waPhoneNumberId" = r."phoneNumberId"
  AND b.active AND b."deletedAt" IS NULL
RETURNING r.id;
```

Escalate collisions, unknown ownership, incompatible linked rows and sender mismatch for provider evidence review. Never reassign an existing receipt or force it to a new tenant. Unfinished receipts older than 30 days expire and redact normalized inputs. Finished receipts are pruned 30 days after completion or failure. Closed phone history is retained for up to 60 days. Conversation rows, payment evidence and media objects follow the business data lifecycle. Receipt pruning leaves those records available. Object writes interrupted during ownership changes can leave an unattached object under the original tenant prefix. The media API only serves objects attached to verified messages. Storage lifecycle cleanup for such objects is operational and was not exercised locally.

## Migration and rollout

The additive migration keeps the original receipt table, keys, G1-01 schema history and state values. It adds fields, one state, a phone identity history table and a business change trigger. Apply before starting the matching HTTP and worker revisions. For any future approved rollout, pause old webhook ingress while switching revisions and reconcile outstanding pre-G1-06 legacy queue jobs under their original tenant. The old queue consumer remains for cutover jobs and uses the bounded transfer adapter. Resume ingress with the new HTTP handler and the two receipt lanes together. If roll-forward recovery is required, preserve the additive schema and receipts. Pausing a worker leaves committed receipts available for recovery. A rollback that would route new media back through the old path needs an explicit operational decision about pausing ingress and draining.
