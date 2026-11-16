-- Apply to an isolated database on the Batch 4 schema with its historical test data.
INSERT INTO messages (id, "businessId", "customerId", "waMessageId", direction, body, "createdAt") VALUES
  ('b5-historical-inbound', 'b2-upgrade-shop', 'b2-upgrade-customer', 'b5-historical-inbound', 'INBOUND', 'Previous inbound fixture', '2026-11-12 12:00:00'),
  ('b5-historical-outbound', 'b2-upgrade-shop', 'b2-upgrade-customer', 'b5-historical-outbound', 'OUTBOUND', 'Previous outbound fixture', '2026-11-12 12:01:00');
