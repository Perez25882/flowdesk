-- CreateEnum
CREATE TYPE "WhatsAppConnectionState" AS ENUM ('DISCONNECTED', 'ACTIVE', 'TOKEN_INVALID', 'NUMBER_UNAVAILABLE', 'RATE_LIMITED');

-- AlterTable
ALTER TABLE "businesses" ADD COLUMN     "waConnectionCheckedAt" TIMESTAMP(3),
ADD COLUMN     "waConnectionError" TEXT,
ADD COLUMN     "waConnectionState" "WhatsAppConnectionState" NOT NULL DEFAULT 'DISCONNECTED',
ADD COLUMN     "waDisplayNumber" TEXT,
ADD COLUMN     "waTokenExpiresAt" TIMESTAMP(3),
ADD COLUMN     "waVerifiedName" TEXT,
ADD COLUMN     "waWabaId" TEXT;
