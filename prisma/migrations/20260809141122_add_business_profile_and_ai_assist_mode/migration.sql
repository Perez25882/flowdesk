-- CreateEnum
CREATE TYPE "BusinessType" AS ENUM ('PROVISIONS', 'FOOD', 'FASHION', 'BEAUTY', 'ELECTRONICS', 'PHARMACY', 'HARDWARE', 'AGRICULTURE', 'WHOLESALE', 'SERVICES', 'OTHER');

-- CreateEnum
CREATE TYPE "AiAssistMode" AS ENUM ('OFF', 'DRAFT_ONLY', 'GROUNDED_AUTO');

-- AlterTable
ALTER TABLE "businesses" ADD COLUMN     "aiAssistMode" "AiAssistMode" NOT NULL DEFAULT 'DRAFT_ONLY',
ADD COLUMN     "businessPolicyNotes" TEXT,
ADD COLUMN     "businessProfile" JSONB,
ADD COLUMN     "businessType" "BusinessType",
ADD COLUMN     "businessTypeOther" TEXT,
ADD COLUMN     "profileUpdatedAt" TIMESTAMP(3);
