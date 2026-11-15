ALTER TABLE fulfillment_tasks ALTER COLUMN "orderId" DROP NOT NULL;
ALTER TABLE fulfillment_tasks DROP CONSTRAINT fulfillment_tasks_kind_check;
ALTER TABLE fulfillment_tasks ADD CONSTRAINT fulfillment_tasks_kind_check CHECK (
  (kind IN ('NOTIFY', 'DELETE_PROOF') AND "orderId" IS NOT NULL)
  OR (kind = 'OWNER_LOW_STOCK' AND "orderId" IS NULL)
);
