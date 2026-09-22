/**
 * Connects one business row to the WhatsApp number configured in .env.
 *
 * Embedded Signup normally writes these fields; in local development there is
 * no signup dialog, so this does the same thing with the same encryption —
 * the access token goes through `encryptSecret`, never into the column raw.
 *
 *   pnpm --filter @flowdesk/api exec tsx ../../qa/connect-number.ts <business-email>
 *
 * Wrapped in main() rather than using top-level await: this file sits outside
 * apps/api, so tsx compiles it as CommonJS and top-level await is a hard error
 * there.
 */
import { PrismaClient } from '@prisma/client';
import { encryptSecret } from '../apps/api/src/utils/crypto.js';

const email = process.argv[2];
if (!email) {
  console.error('usage: connect-number.ts <business-email>');
  process.exit(1);
}

const phoneNumberId = process.env.META_PHONE_NUMBER_ID;
const token = process.env.META_ACCESS_TOKEN;
if (!phoneNumberId || !token) {
  console.error('META_PHONE_NUMBER_ID and META_ACCESS_TOKEN must be set in .env');
  process.exit(1);
}

const prisma = new PrismaClient();

async function main(): Promise<void> {

  const business = await prisma.business.findFirst({
    where: { email, deletedAt: null },
    select: { id: true, name: true, email: true, waPhoneNumberId: true },
  });

  if (!business) {
    console.error(`no business with email ${email}`);
    process.exit(1);
  }

  // The column is unique: another row holding this id would make the update fail
  // with a constraint error rather than an explanation. Clear it first.
  const conflicting = await prisma.business.findMany({
    where: { waPhoneNumberId: phoneNumberId, id: { not: business.id } },
    select: { id: true, name: true },
  });

  for (const other of conflicting) {
    await prisma.business.update({
      where: { id: other.id },
      data: { waPhoneNumberId: null, waAccessToken: null, waConnectionState: 'DISCONNECTED' },
    });
    console.log(`cleared the number off ${other.name} (${other.id})`);
  }

  const updated = await prisma.business.update({
    where: { id: business.id },
    data: {
      waPhoneNumberId: phoneNumberId,
      waAccessToken: encryptSecret(token),
      waDisplayNumber: process.env.WA_DISPLAY_NUMBER ?? null,
      waVerifiedName: process.env.WA_VERIFIED_NAME ?? null,
      waWabaId: process.env.META_WABA_ID ?? null,
      waConnectionState: 'ACTIVE',
      waConnectionError: null,
      waConnectionCheckedAt: new Date(),
      waWebhookVerified: true,
      active: true,
    },
    select: {
      id: true,
      name: true,
      email: true,
      waPhoneNumberId: true,
      waDisplayNumber: true,
      waConnectionState: true,
      catalogueMode: true,
      aiAssistMode: true,
    },
  });

  console.log('connected:', JSON.stringify(updated, null, 2));
  await prisma.$disconnect();

}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
