# ADR 0002 — Durable WhatsApp ingress

- **Date** 2026-11-09
- **Status** Accepted for G1-01 by the founder

## Context

The Meta route uses a Redis marker before queue insertion and can return success even when a supported inbound message has no queued job. The system lacks a durable record from which to recover that gap.

## Decision

Persist a minimal authenticated text-message receipt in Postgres before acknowledging it. Key it by provider, phone-number identity and message ID. Use BullMQ for execution, with a bounded dispatcher that can reconstruct work from a receipt after a queue failure or restart. Scope recovery to the correct tenant and record an explicit waiting or failed state when the phone-number mapping cannot be resolved.

## Alternatives considered

Returning a retryable status and removing the early Redis marker is a smaller patch. Recovery still depends on the provider retry window and queue durability. Moving the whole pipeline to a new broker adds infrastructure and migration risk.

## Consequences

A supported text event becomes recoverable before downstream work runs. The worker uses short Postgres transactions and row locks. A process exit releases the claim, and a committed message plus a deterministic BullMQ identity allows recovery across enqueue boundaries. Keep schema changes additive and use existing Postgres and Redis. G1-01 is an ingress slice. Later assignments cover other inbound event types, commercial-effect idempotency and provider delivery verification. See the [workflow and runbook](../g1/whatsapp-text-ingress.md).
