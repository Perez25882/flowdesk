/**
 * Offline evaluation: what would we do with yesterday's messages today?
 *
 * Every assistant call stores its decision on the message row. This replays
 * those stored decisions through the CURRENT retrieval, invariants and router
 * and reports what each one would do now — without calling a model, spending
 * anything, or touching a customer.
 *
 * It answers the question you actually have after changing a guardrail: did that
 * widen auto-send, or narrow it, and on which messages? Comparing the printed
 * action against the `aiReplyStatus` recorded at the time shows the drift.
 *
 *   pnpm --filter @flowdesk/api exec tsx src/scripts/replay-decisions.ts [businessId]
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../config/database.js';
import { redis } from '../config/redis.js';
import { assembleContext, loadAssistantBusiness } from '../services/assistant/context-builder.js';
import { applyServerInvariants, parseDecision } from '../services/assistant/decision.js';
import { routeDecision } from '../services/assistant/router.js';
import { findCatalogProductsWithStock } from '../modules/products/products.repository.js';
import type { AssistantAction } from '@flowdesk/shared';

const LIMIT = 500;

async function main(): Promise<void> {
  const businessId = process.argv[2];

  const messages = await prisma.message.findMany({
    where: {
      ...(businessId ? { businessId } : {}),
      aiDecision: { not: Prisma.DbNull },
      body: { not: null },
    },
    orderBy: { createdAt: 'desc' },
    take: LIMIT,
    select: {
      id: true,
      businessId: true,
      body: true,
      aiDecision: true,
      aiReplyStatus: true,
      aiValidationFailed: true,
    },
  });

  if (messages.length === 0) {
    console.log('No stored decisions to replay.');
    return;
  }

  // Catalogue and profile are per-business and the replay set is usually one
  // busy tenant, so loading them once each keeps this to a couple of queries.
  const catalogues = new Map<string, Awaited<ReturnType<typeof findCatalogProductsWithStock>>>();
  const businesses = new Map<string, Awaited<ReturnType<typeof loadAssistantBusiness>>>();

  const tally = new Map<string, number>();
  const changed: string[] = [];

  for (const message of messages) {
    if (!businesses.has(message.businessId)) {
      businesses.set(message.businessId, await loadAssistantBusiness(message.businessId));
      catalogues.set(message.businessId, await findCatalogProductsWithStock(message.businessId));
    }

    const business = businesses.get(message.businessId);
    const catalog = catalogues.get(message.businessId) ?? [];
    if (!business) continue;

    const parsed = parseDecision(message.aiDecision);
    if (!parsed) {
      bump(tally, 'unparseable');
      continue;
    }

    const context = assembleContext({
      business,
      catalog,
      openOrders: [],
      history: [],
      awaitingClarification: null,
      message: message.body ?? '',
    });

    const route = routeDecision({
      mode: business.aiAssistMode,
      decision: applyServerInvariants(parsed, context.evidence),
      evidence: context.evidence,
      products: context.products,
      profile: context.profile,
      serverEscalation: false,
      clarificationCount: 0,
      canDeliver: true,
    catalogueMode: 'CATALOGUE',
    message: '',
    });

    bump(tally, route.action);

    // What was recorded at the time, mapped onto today's vocabulary.
    const before: AssistantAction | 'none' =
      message.aiReplyStatus === 'AUTO_SENT'
        ? 'auto_send'
        : message.aiReplyStatus === 'DRAFT'
          ? 'draft'
          : 'none';

    if (before !== 'none' && before !== route.action) {
      changed.push(
        `${message.id}  ${before} -> ${route.action}` +
          (route.validationFailures.length ? `  (${route.validationFailures.join(',')})` : '') +
          `\n    ${(message.body ?? '').slice(0, 90)}`,
      );
    }
  }

  console.log(`Replayed ${messages.length} stored decisions.\n`);
  for (const [action, count] of [...tally.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${action.padEnd(16)} ${count}`);
  }

  if (changed.length > 0) {
    console.log(`\n${changed.length} would be routed differently now:\n`);
    for (const line of changed.slice(0, 40)) console.log(`  ${line}`);
  } else {
    console.log('\nNo routing changes against what was recorded at the time.');
  }
}

function bump(tally: Map<string, number>, key: string): void {
  tally.set(key, (tally.get(key) ?? 0) + 1);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    redis.disconnect();
  });
