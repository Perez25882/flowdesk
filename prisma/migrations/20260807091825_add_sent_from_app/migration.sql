-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "sentFromApp" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "messages_customerId_sentFromApp_createdAt_idx" ON "messages"("customerId", "sentFromApp", "createdAt" DESC);
