-- Disposable fixture after the G1-04 migration and before G1-03.
BEGIN;
INSERT INTO orders (id, "businessId", "customerId", "referenceNumber", "rawMessage", status, "totalAmount", "updatedAt")
VALUES ('g103-legacy-order', 'g104-legacy-shop', 'g104-legacy-first', 'G103-FIXTURE', 'Synthetic order', 'CONFIRMED', 50, now());
INSERT INTO payment_requests (
  id, "businessId", "customerId", "orderId", amount, reference, "authorizationUrl", status, "expiresAt", "updatedAt"
) VALUES (
  'g103-legacy-half', 'g104-legacy-shop', 'g104-legacy-first', 'g103-legacy-order',
  20, 'fdpay-legacy-half', 'https://checkout.invalid', 'PAID', now(), now()
);
INSERT INTO payments (
  id, "businessId", "customerId", "orderId", amount, method, confidence, reference, "updatedAt"
) VALUES (
  'g103-legacy-unlinked', 'g104-legacy-shop', 'g104-legacy-first', 'g103-legacy-order',
  20, 'CASH', 'GATEWAY_CONFIRMED', 'fdpay-legacy-half', now()
);
COMMIT;
