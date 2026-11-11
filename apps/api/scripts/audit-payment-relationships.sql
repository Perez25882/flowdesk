BEGIN TRANSACTION READ ONLY;

WITH entries AS (
  SELECT 'payment' AS kind, id, "businessId", "customerId", "orderId", NULL::text AS "paymentId", reference
  FROM payments
  UNION ALL
  SELECT 'payment_request', id, "businessId", "customerId", "orderId", "paymentId", reference
  FROM payment_requests
), issues AS (
  SELECT e.kind, e.id, e."businessId", problem.code
  FROM entries e
  LEFT JOIN customers c ON c.id = e."customerId"
  LEFT JOIN orders o ON o.id = e."orderId"
  LEFT JOIN payments p ON p.id = e."paymentId"
  CROSS JOIN LATERAL (VALUES
    ('CUSTOMER_TENANT', c."businessId" IS DISTINCT FROM e."businessId"),
    ('ORDER_TENANT', e."orderId" IS NOT NULL AND o."businessId" IS DISTINCT FROM e."businessId"),
    ('ORDER_CUSTOMER', o.id IS NOT NULL AND o."customerId" IS DISTINCT FROM e."customerId"),
    ('SETTLEMENT_IDENTITY', e."paymentId" IS NOT NULL AND (
      p.id IS NULL OR p."businessId" IS DISTINCT FROM e."businessId" OR
      p."customerId" IS DISTINCT FROM e."customerId" OR p."orderId" IS DISTINCT FROM e."orderId" OR
      p.reference IS DISTINCT FROM e.reference
    ))
  ) AS problem(code, present)
  WHERE problem.present
)
SELECT kind, id, "businessId", code FROM issues ORDER BY kind, id, code;

COMMIT;
