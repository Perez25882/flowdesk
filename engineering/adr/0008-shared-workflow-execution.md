# 0008 Shared workflow execution and G1 effect ownership

Use PostgreSQL workflow instances, append-only transition evidence and per-business configuration inside the existing API. The inbound dispatcher admits the workflow in the same transaction as its authenticated message. A PostgreSQL scheduler locks one due row per transaction. A worker exit rolls back an incomplete transition and releases the claim. External calls remain in the existing G1 workers with their existing durable intents, leases and verification. Each handoff points to the committed domain record. Customer, tenant and source are part of every evidence lookup.

Use a small registry of immutable server-controlled definitions. Pin each admitted instance to a definition and policy revision. Owners can choose presets and narrow automation through settings. Financial ledgers, appointment capacity, staff assignment, assistant grounding and outbound policy stay in the services that enforce them.

Cancellation stops future workflow commands. Once a Money, Booking or Operations effect has committed, the relevant existing domain service owns compensation. A provider callback may still reconcile an existing provider intent and the workflow stays terminal.
