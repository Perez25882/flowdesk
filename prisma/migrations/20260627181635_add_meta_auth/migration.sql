-- DropIndex
DROP INDEX "businesses_phone_key";

-- AlterTable
ALTER TABLE "businesses" ADD COLUMN     "email" TEXT,
ADD COLUMN     "metaUserId" TEXT,
ALTER COLUMN "phone" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "businesses_metaUserId_key" ON "businesses"("metaUserId");
