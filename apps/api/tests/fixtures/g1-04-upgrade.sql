-- Apply only to a disposable synthetic database at the verified G1-02 schema.
BEGIN;
INSERT INTO businesses (id, name, "ownerName", "updatedAt") VALUES
  ('g104-legacy-shop', 'Synthetic legacy shop', 'Synthetic owner', now()),
  ('g104-legacy-foreign', 'Synthetic foreign shop', 'Synthetic owner', now());
INSERT INTO customers (id, "businessId", "waNumber", "updatedAt") VALUES
  ('g104-legacy-first', 'g104-legacy-shop', '233200000001', now()),
  ('g104-legacy-second', 'g104-legacy-shop', '233200000002', now()),
  ('g104-legacy-foreign-customer', 'g104-legacy-foreign', '233200000003', now());
INSERT INTO orders (id, "businessId", "customerId", "referenceNumber", "rawMessage", status, "totalAmount", "updatedAt") VALUES
  ('g104-legacy-order', 'g104-legacy-shop', 'g104-legacy-first', 'FIXTURE', 'Synthetic order', 'CONFIRMED', 50, now());
INSERT INTO payments (id, "businessId", "customerId", "orderId", amount, method, confidence, reference, "updatedAt") VALUES
  ('g104-legacy-mismatch', 'g104-legacy-shop', 'g104-legacy-second', 'g104-legacy-order', 20, 'CASH', 'SELLER_ATTESTED', NULL, now()),
  ('g104-legacy-credit', 'g104-legacy-shop', 'g104-legacy-first', NULL, 15, 'CARD', 'GATEWAY_CONFIRMED', 'g104-legacy-reference', now()),
  ('g104-legacy-foreign-payment', 'g104-legacy-foreign', 'g104-legacy-foreign-customer', 'g104-legacy-order', 100, 'CASH', 'SELLER_ATTESTED', NULL, now());
INSERT INTO payment_requests (id, "businessId", "customerId", amount, reference, "authorizationUrl", status, "paymentId", "expiresAt", "updatedAt") VALUES
  ('g104-legacy-request', 'g104-legacy-shop', 'g104-legacy-first', 15, 'g104-legacy-reference', 'https://provider.invalid', 'PAID', 'g104-legacy-credit', now(), now()),
  ('g104-legacy-link-mismatch', 'g104-legacy-shop', 'g104-legacy-second', 15, 'g104-legacy-bad-ref', 'https://provider.invalid', 'PAID', 'g104-legacy-mismatch', now(), now());
INSERT INTO staff (id, "businessId", name, phone, role, "updatedAt") VALUES
  ('g104-legacy-staff', 'g104-legacy-shop', 'Synthetic staff', '233200000003', 'MANAGER', now());
INSERT INTO staff_activity (id, "staffId", action) VALUES
  ('g104-legacy-activity', 'g104-legacy-staff', 'payment.logged');
COMMIT;
