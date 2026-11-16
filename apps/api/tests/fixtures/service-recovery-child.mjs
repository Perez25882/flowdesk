for (const name of ['DATABASE_URL', 'REDIS_URL']) {
  const url = new URL(process.env[name]);
  if (url.hostname !== '127.0.0.1' || !url.port || (name === 'DATABASE_URL' && !url.pathname.startsWith('/flowdesk_g1_'))) {
    throw new Error('Service interruption fixture requires disposable loopback services');
  }
}
const [point, instant] = process.argv.slice(2);
const { recoverWorkflows } = await import('../../dist/modules/workflows/workflow.worker.js');
await recoverWorkflows(new Date(instant), async (checkpoint) => {
  if (checkpoint !== point) return;
  await new Promise((resolve, reject) => process.send(checkpoint, (error) => error ? reject(error) : resolve()));
  await new Promise(() => { setInterval(() => {}, 1000); });
});
process.exitCode = 3;
process.disconnect();
