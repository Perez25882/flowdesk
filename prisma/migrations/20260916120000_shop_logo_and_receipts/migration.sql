-- AlterTable
ALTER TABLE "businesses"
  ADD COLUMN "logoKey" TEXT,
  ADD COLUMN "logoMimeType" TEXT,
  ADD COLUMN "logoWaMediaId" TEXT,
  ADD COLUMN "logoWaMediaPhoneNumberId" TEXT,
  ADD COLUMN "logoWaMediaUploadedAt" TIMESTAMP(3),
  ADD COLUMN "receiptsEnabled" BOOLEAN NOT NULL DEFAULT true;
