-- AlterEnum
ALTER TYPE "AiAssistMode" ADD VALUE 'AUTONOMOUS';

-- AlterTable
ALTER TABLE "businesses"
  ADD COLUMN "autonomyAcceptedAt" TIMESTAMP(3),
  ADD COLUMN "autonomyAcceptedBy" TEXT,
  ADD COLUMN "autonomyAcceptedText" TEXT;
