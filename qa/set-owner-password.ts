/**
 * Set an owner's password locally.
 *
 * Email password reset needs RESEND_API_KEY and RESEND_FROM_EMAIL, which are
 * not configured on this machine, so `/forgot-password` writes to the log
 * instead of sending anything. That leaves no way back into an account whose
 * password has been lost, which is what this exists for.
 *
 * You choose the password and pass it in. It is hashed with bcrypt at the same
 * cost factor the API uses (12, `BCRYPT_ROUNDS` in auth.service.ts) so the
 * stored hash is indistinguishable from one the app wrote itself. Nothing here
 * prints the password, and nothing stores it anywhere but the hash column.
 *
 * Run from the repo root:
 *
 *   $env:NODE_ENV='development'
 *   pnpm --filter @flowdesk/api exec tsx ../../qa/set-owner-password.ts --email you@example.com --password "the new one"
 *
 * With no --email it lists the accounts it can see and stops, which is the
 * quickest way to find out what you registered with.
 */
import bcrypt from 'bcrypt';
import { PrismaClient } from '@prisma/client';

const BCRYPT_ROUNDS = 12;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();

  try {
    const email = arg('email');
    const password = arg('password');

    if (!email) {
      const rows = await prisma.business.findMany({
        select: {
          email: true,
          name: true,
          ownerName: true,
          passwordHash: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        take: 20,
      });

      if (rows.length === 0) {
        console.log('No businesses exist. Register at http://localhost:5173/register');
        return;
      }

      console.log(`${rows.length} account(s):\n`);
      for (const r of rows) {
        console.log(
          `  ${r.email ?? '(no email)'}  ${r.passwordHash ? 'has password' : 'NO PASSWORD SET'}` +
            `  ${r.name}  (${r.ownerName})  ${r.createdAt.toISOString().slice(0, 10)}`,
        );
      }
      console.log('\nRe-run with --email <one of the above> --password "..." to set one.');
      return;
    }

    if (!password) {
      console.error('--password is required when --email is given.');
      process.exitCode = 1;
      return;
    }

    // The API's own rule, from packages/shared MIN_PASSWORD_LENGTH.
    if (password.length < 10) {
      console.error('Password must be at least 10 characters.');
      process.exitCode = 1;
      return;
    }

    const business = await prisma.business.findFirst({
      where: { email },
      select: { id: true, name: true },
    });

    if (!business) {
      console.error(`No business with email ${email}. Run without --email to list them.`);
      process.exitCode = 1;
      return;
    }

    await prisma.business.update({
      where: { id: business.id },
      data: { passwordHash: await bcrypt.hash(password, BCRYPT_ROUNDS) },
    });

    console.log(`Password set for ${email} (${business.name}). Sign in at http://localhost:5173/login`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
