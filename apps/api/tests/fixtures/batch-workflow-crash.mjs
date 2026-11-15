const database = new URL(process.env.DATABASE_URL ?? 'invalid:database');
if (database.hostname !== '127.0.0.1' || !database.pathname.startsWith('/flowdesk_g1_') || !process.send) {
  throw new Error('Disposable PostgreSQL and fixture IPC required');
}
const { runDueWorkflow } = await import('../../dist/modules/workflows/workflow.store.js');

await runDueWorkflow(new Date(), async (tx, row) => {
  if (row.id !== process.argv[2]) throw new Error('Unexpected due workflow in crash fixture');
  await tx.workflowEvidence.create({ data: {
    workflowId: row.id, businessId: row.businessId, eventKey: 'crashed-attempt', eventType: 'PROCESSING',
    state: 'RUNNING', operator: row.operator, reason: 'UNCOMMITTED_TEST_WRITE', facts: {},
  } });
  process.send?.('locked');
  await new Promise((resolve) => setTimeout(resolve, 60_000));
});
