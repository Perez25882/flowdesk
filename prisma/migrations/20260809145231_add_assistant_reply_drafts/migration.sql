-- CreateEnum
CREATE TYPE "AiReplyStatus" AS ENUM ('DRAFT', 'AUTO_SENT', 'SENT', 'DISMISSED', 'SUPERSEDED', 'EXPIRED');

-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "aiDecision" JSONB,
ADD COLUMN     "aiDetectedLanguage" TEXT,
ADD COLUMN     "aiReplyGroundedOn" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "aiReplyModel" TEXT,
ADD COLUMN     "aiReplyStatus" "AiReplyStatus",
ADD COLUMN     "aiReplyText" TEXT,
ADD COLUMN     "aiValidationFailed" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "inReplyToMessageId" TEXT,
ADD COLUMN     "sentByStaffId" TEXT;

-- CreateIndex
CREATE INDEX "messages_businessId_aiReplyStatus_createdAt_idx" ON "messages"("businessId", "aiReplyStatus", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "messages_inReplyToMessageId_idx" ON "messages"("inReplyToMessageId");
