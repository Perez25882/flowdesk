-- Appointments.
--
-- The whole feature rests on one promise: a booking never clashes with another
-- booking. That promise is kept by the database, not by the application being
-- careful, because "check whether the slot is free, then insert" is a race and
-- two customers messaging a clinic in the same second is exactly when it loses.
--
-- btree_gist is what lets an exclusion constraint mix an equality test on a
-- text column with an overlap test on a time range. It ships with Postgres as
-- a standard contrib module and is available on Supabase, RDS and Render.

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TYPE "AppointmentStatus" AS ENUM ('BOOKED', 'CONFIRMED', 'COMPLETED', 'CANCELLED', 'NO_SHOW');

CREATE TABLE "services" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "durationMinutes" INTEGER NOT NULL,
    "bufferMinutes" INTEGER NOT NULL DEFAULT 0,
    "capacity" INTEGER NOT NULL DEFAULT 1,
    "price" DECIMAL(12,2),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "services_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "services_businessId_idx" ON "services"("businessId");
CREATE INDEX "services_businessId_active_idx" ON "services"("businessId", "active");

ALTER TABLE "services" ADD CONSTRAINT "services_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A zero-minute service would produce an appointment that starts and ends at
-- the same instant, which no overlap test can ever exclude: an empty range
-- overlaps nothing, so an unlimited number of them would fit in one slot.
ALTER TABLE "services" ADD CONSTRAINT "services_duration_sane"
  CHECK ("durationMinutes" >= 5 AND "durationMinutes" <= 1440);
ALTER TABLE "services" ADD CONSTRAINT "services_buffer_sane"
  CHECK ("bufferMinutes" >= 0 AND "bufferMinutes" <= 480);
ALTER TABLE "services" ADD CONSTRAINT "services_capacity_sane"
  CHECK ("capacity" >= 1 AND "capacity" <= 50);

CREATE TABLE "appointments" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "blockedUntil" TIMESTAMP(3) NOT NULL,
    "resourceIndex" INTEGER NOT NULL DEFAULT 0,
    "status" "AppointmentStatus" NOT NULL DEFAULT 'BOOKED',
    "notes" TEXT,
    "bookedByAssistant" BOOLEAN NOT NULL DEFAULT false,
    "remindedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "appointments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "appointments_businessId_reference_key" ON "appointments"("businessId", "reference");
CREATE INDEX "appointments_businessId_idx" ON "appointments"("businessId");
CREATE INDEX "appointments_businessId_startsAt_idx" ON "appointments"("businessId", "startsAt");
CREATE INDEX "appointments_businessId_status_startsAt_idx" ON "appointments"("businessId", "status", "startsAt");
CREATE INDEX "appointments_customerId_idx" ON "appointments"("customerId");
CREATE INDEX "appointments_serviceId_startsAt_idx" ON "appointments"("serviceId", "startsAt");

ALTER TABLE "appointments" ADD CONSTRAINT "appointments_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_serviceId_fkey"
  FOREIGN KEY ("serviceId") REFERENCES "services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_customerId_fkey"
  FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "appointments" ADD CONSTRAINT "appointments_times_sane"
  CHECK ("endsAt" > "startsAt" AND "blockedUntil" >= "endsAt");
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_resource_sane"
  CHECK ("resourceIndex" >= 0);

-- The promise, kept structurally.
--
-- No two live appointments may share a service AND a resource AND any part of
-- a moment in time. The range runs to `blockedUntil` rather than `endsAt` so
-- the buffer is genuinely unavailable rather than merely intended to be.
--
-- Half-open, '[)': an appointment ending at 10:00 and one starting at 10:00 do
-- not overlap. With a closed range they would, and a diary of back-to-back
-- thirty-minute slots would refuse every second booking.
--
-- Cancelled and no-show rows are excluded, so a cancelled 2pm frees 2pm.
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_no_overlap"
  EXCLUDE USING gist (
    "serviceId" WITH =,
    "resourceIndex" WITH =,
    tsrange("startsAt", "blockedUntil", '[)') WITH &&
  ) WHERE ("status" IN ('BOOKED', 'CONFIRMED', 'COMPLETED'));

ALTER TABLE "businesses" ADD COLUMN "bookingsEnabled" BOOLEAN NOT NULL DEFAULT false;
