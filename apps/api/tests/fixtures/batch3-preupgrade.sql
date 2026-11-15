BEGIN;
INSERT INTO businesses (id, name, "ownerName", "updatedAt")
VALUES ('b2-upgrade-shop', 'Synthetic approved Batch 2 shop', 'Fixture', now());

INSERT INTO customers (id, "businessId", "waNumber", "updatedAt")
VALUES ('b2-upgrade-customer', 'b2-upgrade-shop', '233209999993', now());

INSERT INTO messages (id, "businessId", "customerId", "waMessageId", direction, type, body)
VALUES ('b2-upgrade-message', 'b2-upgrade-shop', 'b2-upgrade-customer', 'synth-b2-upgrade', 'INBOUND', 'TEXT', 'Fixture');

INSERT INTO workflow_settings ("businessId", profile, enabled, "updatedAt")
VALUES ('b2-upgrade-shop', 'ONLINE_RETAIL', true, now());

INSERT INTO workflows (id, "businessId", "customerId", "sourceId", "correlationKey", definition, version, "policyRevision",
  state, operator, reason, "deadlineAt", "updatedAt")
VALUES ('a4a66288-75dd-4276-929d-e38ba5e47c73', 'b2-upgrade-shop', 'b2-upgrade-customer', 'b2-upgrade-message',
  'whatsapp:b2-upgrade', 'whatsapp-business', 1, 1, 'WAITING_OWNER_APPROVAL', 'CARE', 'OWNER_STATUS_APPROVAL', now() + interval '1 day', now());

INSERT INTO workflow_evidence ("workflowId", "businessId", "eventKey", "eventType", state, operator, reason, facts)
VALUES ('a4a66288-75dd-4276-929d-e38ba5e47c73', 'b2-upgrade-shop', 'approval:requested', 'APPROVAL_REQUESTED',
  'WAITING_OWNER_APPROVAL', 'CARE', 'OWNER_STATUS_APPROVAL', '{}');

INSERT INTO workflow_approvals ("workflowId", "businessId", action, "resourceId", "evidenceKey", "definitionVersion", "policyRevision", "expiresAt")
VALUES ('a4a66288-75dd-4276-929d-e38ba5e47c73', 'b2-upgrade-shop', 'SEND_VERIFIED_STATUS', 'b2-order-reference',
  'order-status:CONFIRMED', 1, 1, now() + interval '1 day');
COMMIT;
