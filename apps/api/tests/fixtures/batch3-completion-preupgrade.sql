-- Apply to the previous Batch 3 schema after batch3-preupgrade.sql.
BEGIN;
INSERT INTO products (id, "businessId", name, unit, price, "stockQuantity", "commerceMode", "updatedAt")
VALUES ('b3-legacy-product', 'b2-upgrade-shop', 'Historical tracked item', 'piece', 40, 5, 'TRACKED', now());
INSERT INTO orders (id, "businessId", "customerId", "referenceNumber", "rawMessage", status, "totalAmount", "amountPaid", "stockDeducted", "updatedAt")
VALUES ('b3-legacy-order', 'b2-upgrade-shop', 'b2-upgrade-customer', 'FD-HISTORY', 'Synthetic historical order', 'FULFILLED', 40, 40, false, now());
INSERT INTO order_items (id, "orderId", "productId", description, quantity, "unitPrice", subtotal, matched)
VALUES ('b3-legacy-order-item', 'b3-legacy-order', 'b3-legacy-product', 'Historical tracked item', 1, 40, 40, true);
INSERT INTO commerce_quotes (id, "businessId", "customerId", "orderId", "requestKey", "requestHash", state, "deliveryMode", total, "policyRevision", "expiresAt")
VALUES ('b3-legacy-quote', 'b2-upgrade-shop', 'b2-upgrade-customer', 'b3-legacy-order', 'legacy-key', 'legacy-hash', 'ACCEPTED', 'PICKUP', 40, 1, now());
INSERT INTO commerce_quote_lines ("quoteId", "businessId", "productId", "itemName", quantity, "productMode", "listPrice", "unitPrice")
VALUES ('b3-legacy-quote', 'b2-upgrade-shop', 'b3-legacy-product', 'Historical tracked item', 1, 'TRACKED', 40, 40);
INSERT INTO commerce_invoices (id, "businessId", "customerId", "orderId", reference, "receiptLines", total, "releaseThreshold", "dueAt")
VALUES ('b3-legacy-invoice', 'b2-upgrade-shop', 'b2-upgrade-customer', 'b3-legacy-order', 'INV-HISTORY',
  '[{"name":"Historical tracked item","quantity":1,"unitPrice":"40.00","subtotal":"40.00"}]', 40, 40, now());
INSERT INTO payments (id, "businessId", "customerId", "orderId", amount, method, confidence, reference, "updatedAt")
VALUES ('b3-legacy-payment', 'b2-upgrade-shop', 'b2-upgrade-customer', 'b3-legacy-order', 40, 'CARD', 'GATEWAY_CONFIRMED', 'fdpay-history', now());
INSERT INTO payment_requests (id, "businessId", "customerId", "orderId", amount, reference, "authorizationUrl", status, "expiresAt", "paymentId", "updatedAt")
VALUES ('b3-legacy-request', 'b2-upgrade-shop', 'b2-upgrade-customer', 'b3-legacy-order', 40, 'fdpay-history', 'https://checkout.invalid',
  'PAID', now(), 'b3-legacy-payment', now());
INSERT INTO paystack_receipts (id, "eventKey", reference, "businessId", "requestId", state, "updatedAt")
VALUES ('b3-legacy-receipt', 'history-event', 'fdpay-history', 'b2-upgrade-shop', 'b3-legacy-request', 'SETTLED', now());
INSERT INTO paystack_settlements (id, "transactionId", "requestId", "paymentId", "receiptId", "notificationState")
VALUES ('b3-legacy-settlement', '8765001', 'b3-legacy-request', 'b3-legacy-payment', 'b3-legacy-receipt', 'SUPPRESSED');
INSERT INTO commerce_cases (id, "businessId", "customerId", "sourceId", "orderId", kind, state, resolution, revision, "updatedAt")
VALUES ('b3-legacy-return', 'b2-upgrade-shop', 'b2-upgrade-customer', 'historical-full-return', 'b3-legacy-order',
  'RETURN', 'WAITING', 'RETURN_RECEIVED_TO_STOCK', 1, now());
INSERT INTO commerce_case_events ("caseId", "businessId", revision, state, resolution)
VALUES ('b3-legacy-return', 'b2-upgrade-shop', 1, 'WAITING', 'RETURN_RECEIVED_TO_STOCK');
INSERT INTO stock_movements (id, "businessId", "productId", type, quantity, "balanceAfter", "orderId", note)
VALUES ('b3-legacy-movement', 'b2-upgrade-shop', 'b3-legacy-product', 'RETURN', 1, 5, 'b3-legacy-order', 'Commerce return received');
COMMIT;
