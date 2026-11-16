BEGIN;

-- Exclude message writers only while taking the historical count and installing its trigger.
SET LOCAL lock_timeout = '5s';
LOCK TABLE "messages" IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE "inbox_threads" (
    "businessId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "inboundPosition" BIGINT NOT NULL DEFAULT 0,
    "assignedStaffId" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "inbox_threads_pkey" PRIMARY KEY ("businessId", "customerId"),
    CONSTRAINT "inbox_threads_customerId_key" UNIQUE ("customerId"),
    CONSTRAINT "inbox_threads_customerId_businessId_fkey" FOREIGN KEY ("customerId", "businessId")
        REFERENCES "customers"("id", "businessId") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "inbox_threads_businessId_assignedStaffId_idx" ON "inbox_threads" ("businessId", "assignedStaffId");

CREATE TABLE "inbox_readers" (
    "businessId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "reader" TEXT NOT NULL,
    "position" BIGINT NOT NULL DEFAULT 0,
    "manualUnread" BOOLEAN NOT NULL DEFAULT false,
    "revision" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "inbox_readers_pkey" PRIMARY KEY ("businessId", "customerId", "reader"),
    CONSTRAINT "inbox_readers_businessId_customerId_fkey" FOREIGN KEY ("businessId", "customerId")
        REFERENCES "inbox_threads"("businessId", "customerId") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "inbox_readers_businessId_reader_idx" ON "inbox_readers" ("businessId", "reader");

CREATE TABLE "inbox_assignment_events" (
    "businessId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "actorStaffId" TEXT,
    "previousStaffId" TEXT,
    "assignedStaffId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "inbox_assignment_events_pkey" PRIMARY KEY ("businessId", "customerId", "revision"),
    CONSTRAINT "inbox_assignment_events_businessId_customerId_fkey" FOREIGN KEY ("businessId", "customerId")
        REFERENCES "inbox_threads"("businessId", "customerId") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "inbox_threads" ("businessId", "customerId", "inboundPosition")
SELECT m."businessId", m."customerId", count(*)
FROM "messages" m JOIN "customers" c ON c.id = m."customerId" AND c."businessId" = m."businessId"
WHERE m.direction = 'INBOUND'
GROUP BY m."businessId", m."customerId";

CREATE FUNCTION "inbox_count_inbound_message"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO "inbox_threads" ("businessId", "customerId", "inboundPosition")
    SELECT c."businessId", c.id, 1 FROM "customers" c WHERE c.id = NEW."customerId" AND c."businessId" = NEW."businessId"
    ON CONFLICT ("businessId", "customerId") DO UPDATE
      SET "inboundPosition" = "inbox_threads"."inboundPosition" + 1;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "inbox_count_inbound_after_insert" AFTER INSERT ON "messages"
FOR EACH ROW WHEN (NEW.direction = 'INBOUND' AND NEW."customerId" IS NOT NULL)
EXECUTE FUNCTION "inbox_count_inbound_message"();

COMMIT;
