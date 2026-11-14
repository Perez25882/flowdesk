# Durable WhatsApp media and business-app echoes

**Status** Implemented for G1-06, pending founder sign-off.

## Context

G1-01 made text ingress durable. Media and business-app echoes could be acknowledged after a Redis claim while their application writes were still incomplete. Current phone mapping by itself cannot establish who owned a number when a delayed delivery originated.

## Decision

Extend the existing PostgreSQL receipt table and BullMQ dispatcher. Admit normalized members after raw-byte authentication and before acknowledgment. Persist phone ownership intervals at the business mapping boundary and pin receipts to the interval covering their signed event timestamp. Use a fenced, bounded media lease and a deterministic private object key. An echo completes with the committed outbound message. An inbound media receipt can complete when its archive is linked and its existing classifier handoff is recorded.

## Consequences

The text and echo lane remains available during media download timeouts. Postgres is the authority for admission, ownership and recovery. BullMQ supplies classification scheduling. Captions can use the existing G1-05 authority contract. Transfer failures and unsupported media analysis are explicit. The migration can only prove ownership from the time it runs. The private bucket is a trust boundary for recovering an uploaded object using its metadata and the authenticated event digest.

A separate queue-based ingress framework would have duplicated receipt identity and recovery logic across types. Direct echo writes made it difficult to preserve a replayable receipt when the downstream write failed. See the [workflow and runbook](../g1/whatsapp-media-echo.md).
