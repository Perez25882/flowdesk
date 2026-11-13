ALTER TABLE "messages" ADD COLUMN "aiPolicy" JSONB;
ALTER TABLE "appointments" ADD COLUMN "assistantMessageId" TEXT;
CREATE UNIQUE INDEX "appointments_assistantMessageId_key" ON "appointments"("assistantMessageId");
