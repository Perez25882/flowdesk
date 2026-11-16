BEGIN;
CREATE UNIQUE INDEX "order_items_id_orderId_key" ON order_items (id, "orderId");
CREATE UNIQUE INDEX "commerce_cases_id_businessId_customerId_orderId_key" ON commerce_cases (id, "businessId", "customerId", "orderId");
CREATE TABLE commerce_returns (
  id TEXT PRIMARY KEY, "businessId" TEXT NOT NULL, "customerId" TEXT NOT NULL, "caseId" TEXT NOT NULL, "orderId" TEXT NOT NULL,
  "requestKey" TEXT NOT NULL, "requestHash" TEXT NOT NULL, "verifiedBy" TEXT, "approvedAt" TIMESTAMP(3),
  "resolvedAt" TIMESTAMP(3), "rejectedAt" TIMESTAMP(3),
  "resolutionPaymentId" TEXT UNIQUE REFERENCES payments (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  obligation TEXT NOT NULL CHECK (obligation IN ('NONE', 'REFUND_REVIEW', 'REPLACEMENT', 'EXCHANGE')),
  evidence TEXT NOT NULL, "noticeId" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("businessId", "requestKey"), UNIQUE (id, "orderId"),
  FOREIGN KEY ("caseId", "businessId", "customerId", "orderId") REFERENCES commerce_cases (id, "businessId", "customerId", "orderId") ON DELETE RESTRICT ON UPDATE CASCADE,
  FOREIGN KEY ("orderId", "businessId", "customerId") REFERENCES orders (id, "businessId", "customerId") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "commerce_returns_orderId_idx" ON commerce_returns ("orderId");
CREATE TABLE commerce_return_lines (
  "returnId" TEXT NOT NULL, "orderId" TEXT NOT NULL, "orderItemId" TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0), condition TEXT NOT NULL CHECK (condition IN ('RESTOCKABLE', 'DAMAGED', 'REVIEW')),
  "movementId" TEXT UNIQUE REFERENCES stock_movements (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  PRIMARY KEY ("returnId", "orderItemId"),
  FOREIGN KEY ("returnId", "orderId") REFERENCES commerce_returns (id, "orderId") ON DELETE RESTRICT ON UPDATE CASCADE,
  FOREIGN KEY ("orderItemId", "orderId") REFERENCES order_items (id, "orderId") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "commerce_return_lines_orderItemId_idx" ON commerce_return_lines ("orderItemId");
COMMIT;
