-- AlterTable
ALTER TABLE "businesses"
  ADD COLUMN "insightsEnabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "insightsToWhatsApp" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "daily_insights" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "forDate" DATE NOT NULL,
    "headline" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "facts" JSONB NOT NULL,
    "model" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "daily_insights_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "daily_insights_businessId_forDate_key" ON "daily_insights"("businessId", "forDate");
CREATE INDEX "daily_insights_businessId_forDate_idx" ON "daily_insights"("businessId", "forDate" DESC);

-- AddForeignKey
ALTER TABLE "daily_insights" ADD CONSTRAINT "daily_insights_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
