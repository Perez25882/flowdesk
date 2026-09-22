-- One-time email codes.
CREATE TYPE "OtpPurpose" AS ENUM ('EMAIL_VERIFICATION', 'LOGIN');

CREATE TABLE "email_otps" (
    "id"         TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "purpose"    "OtpPurpose" NOT NULL,
    "codeHash"   TEXT NOT NULL,
    "expiresAt"  TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "attempts"   INTEGER NOT NULL DEFAULT 0,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_otps_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "email_otps_businessId_purpose_createdAt_idx"
  ON "email_otps"("businessId", "purpose", "createdAt" DESC);
-- Supports the sweep that deletes expired rows.
CREATE INDEX "email_otps_expiresAt_idx" ON "email_otps"("expiresAt");

ALTER TABLE "email_otps" ADD CONSTRAINT "email_otps_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Nobody who already has an account gets locked out by a feature that did not
-- exist when they signed up. Every existing business is treated as verified as
-- of the moment it was created; verification applies to accounts made from here
-- on. Without this, turning the check on would strand every current owner
-- behind a code sent to an address that may no longer reach them.
UPDATE "businesses"
   SET "emailVerifiedAt" = COALESCE("emailVerifiedAt", "createdAt")
 WHERE "email" IS NOT NULL;
