-- Apply after the approved Batch 3 migration and the earlier synthetic seeds.
BEGIN;
INSERT INTO services (id, "businessId", name, "durationMinutes", "bufferMinutes", price, "updatedAt")
VALUES ('b4-historical-service', 'b2-upgrade-shop', 'Historical consultation', 45, 15, 40, now());
INSERT INTO appointments (id, "serviceId", "businessId", "customerId", reference, "startsAt", "endsAt", "blockedUntil", status, "updatedAt")
VALUES ('b4-historical-appointment', 'b4-historical-service', 'b2-upgrade-shop', 'b2-upgrade-customer',
  'FD-A-OLD04', '2026-11-19 14:00', '2026-11-19 14:45', '2026-11-19 15:00', 'CONFIRMED', now());
COMMIT;
