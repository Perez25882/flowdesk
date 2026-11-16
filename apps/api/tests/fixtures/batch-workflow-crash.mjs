const database = new URL(process.env.DATABASE_URL ?? 'invalid:database');
if (database.hostname !== '127.0.0.1' || !database.pathname.startsWith('/flowdesk_g1_') || !process.send) {
  throw new Error('Disposable PostgreSQL and fixture IPC required');
}
const { prisma } = await import('../../dist/config/database.js');

// Keep an independent writer's row lock alive until the parent terminates it.
await prisma.$transaction(async (tx) => {
  const [row] = await tx.$queryRaw`SELECT id, "businessId", operator::text FROM workflows
    WHERE id = ${process.argv[2]} AND state = 'CREATED' FOR UPDATE`;
  if (!row) throw new Error('Expected a created workflow in crash fixture');
  await tx.workflowEvidence.create({ data: {
    workflowId: row.id, businessId: row.businessId, eventKey: 'crashed-attempt', eventType: 'PROCESSING',
    state: 'RUNNING', operator: row.operator, reason: 'UNCOMMITTED_TEST_WRITE', facts: {},
  } });
  process.send?.('locked');
  await new Promise((resolve) => setTimeout(resolve, 60_000));
}, { timeout: 45_000 });
