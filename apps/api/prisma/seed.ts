/**
 * Database seeder for local dev. Idempotent — running twice is safe.
 *
 * Creates:
 *   - 1 Business (metaUserId seed-meta-user-id, phone +233244000001, name "Test Provisions")
 *   - 4 Products (Tomatoes, Rice 5kg, Cooking Oil 1L, Sugar) — units chosen so the
 *     dev item-extractor AND the rule-engine's quantity patterns match them
 *     when fed "I want 2 bags tomatoes" etc.
 *   - 2 Customers
 *
 * Reads `apps/api/.env` first so the right DATABASE_URL is used.
 *
 * Run via:
 *   pnpm seed
 * or:
 *   prisma db seed
 */
import { PrismaClient } from '@prisma/client';
import { config } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SEED_BUSINESS_PHONE = '233244000001';
const SEED_META_USER_ID = 'seed-meta-user-id';
const SEED_WA_PHONE_NUMBER_ID = 'seed-phone-id-001';
const TRIAL_DAYS = 14;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
config({ path: path.resolve(__dirname, '../../.env') });

const prisma = new PrismaClient();

interface SeedProduct {
  name: string;
  unit: string;
  price: number;
  stock: number;
  threshold: number;
  aliases: string[];
}

const SEED_PRODUCTS: SeedProduct[] = [
  { name: 'Tomatoes', unit: 'bag', price: 25, stock: 40, threshold: 5, aliases: ['tomato', 'tom'] },
  { name: 'Rice 5kg', unit: 'bag', price: 65, stock: 30, threshold: 5, aliases: ['rice', '5kg rice'] },
  { name: 'Cooking Oil 1L', unit: 'bottle', price: 45, stock: 25, threshold: 5, aliases: ['oil', '1l oil'] },
  { name: 'Sugar', unit: 'pack', price: 18, stock: 0, threshold: 10, aliases: ['sugar'] }, // 0 stock — exercises low-stock alert
];

interface SeedCustomer {
  waNumber: string;
  name: string | null;
}

const SEED_CUSTOMERS: SeedCustomer[] = [
  { waNumber: '233241000001', name: 'Kwame Asante' },
  { waNumber: '233241000002', name: 'Akua Mensah' },
];

async function main(): Promise<void> {
  const trialEndsAt = new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000);

  const business = await prisma.business.upsert({
    where: { metaUserId: SEED_META_USER_ID },
    update: {
      name: 'Test Provisions',
      ownerName: 'Test Owner',
      active: true,
      waPhoneNumberId: SEED_WA_PHONE_NUMBER_ID,
      waWebhookVerified: true,
      trialEndsAt,
    },
    create: {
      name: 'Test Provisions',
      ownerName: 'Test Owner',
      metaUserId: SEED_META_USER_ID,
      phone: SEED_BUSINESS_PHONE,
      active: true,
      waPhoneNumberId: SEED_WA_PHONE_NUMBER_ID,
      waWebhookVerified: true,
      plan: 'STARTER',
      trialEndsAt,
    },
  });

  console.log(`Business ready: ${business.id} (${business.name}, ${business.phone})`);

  for (const product of SEED_PRODUCTS) {
    // active product with matching business+name is treated as the same record
    const existing = await prisma.product.findFirst({
      where: { businessId: business.id, name: product.name, deletedAt: null },
    });

    if (existing) {
      await prisma.product.update({
        where: { id: existing.id },
        data: {
          unit: product.unit,
          price: product.price,
          stockQuantity: product.stock,
          reorderThreshold: product.threshold,
          aliases: product.aliases,
          active: true,
        },
      });
    } else {
      await prisma.product.create({
        data: {
          businessId: business.id,
          name: product.name,
          unit: product.unit,
          price: product.price,
          stockQuantity: product.stock,
          reorderThreshold: product.threshold,
          aliases: product.aliases,
          active: true,
        },
      });
    }
  }

  console.log(`Seeded ${SEED_PRODUCTS.length} products`);

  for (const customer of SEED_CUSTOMERS) {
    await prisma.customer.upsert({
      where: { businessId_waNumber: { businessId: business.id, waNumber: customer.waNumber } },
      update: { name: customer.name },
      create: {
        businessId: business.id,
        waNumber: customer.waNumber,
        name: customer.name,
      },
    });
  }

  console.log(`Seeded ${SEED_CUSTOMERS.length} customers`);

  console.log('\n----- SEED CREDENTIALS -----');
  console.log(`Meta user id: ${SEED_META_USER_ID}`);
  console.log(`Phone:        ${SEED_BUSINESS_PHONE}`);
  console.log(`Owner name:   Test Owner`);
  console.log('Log in via Facebook Login (sign-in button).');
  console.log('In dev you can also manually set a real metaUserId on this row to test.');
  console.log('---------------------------\n');
}

main()
  .catch((error: unknown) => {
    console.error('Seed failed:', error);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
