# 0012 Conversation ownership and reader state

The existing inbox is keyed by tenant and customer. Staff can be responsible for a thread independently of any complaint or return case. Two people reading the same thread have separate acknowledgements.

The new tables keep a thread revision, append-only assignment events and each authenticated reader's acknowledged position. A PostgreSQL trigger increments the inbound position with the committed message insert. The migration takes a consistent historical count and installs the trigger in the same transaction. Read acknowledgements clamp to observed positions and use a revision to protect explicit unread actions. The role and target membership checks run in the assignment transaction. The existing inbox routes, customer links, messaging permissions and domain workers continue to handle conversations and outbound actions.

The migration takes a short exclusive-to-writers lock on `messages`, with a five-second acquisition timeout. Deployment must use a maintenance window sized for the historical aggregate and a recoverable backup. Old workers can keep materializing messages through the new trigger. New binaries require an enabled trigger and complete inbox schema. A rollback to the previous application keeps the additive schema and any reader and assignment history.

See the [inbox contract](../batch-5/conversation-ownership.md) for the UI and API semantics and the [completion register](../batch-5/completion.md) for verification.
