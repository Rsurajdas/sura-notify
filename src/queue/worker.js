import { Worker } from 'bullmq';
import { env } from '../config/env.js';
import { QUEUE_NAME } from './queue.js';
import { sendNow } from '../notifications/dispatcher.js';
import { logger } from '../lib/logger.js';

if (!env.REDIS_URL) {
  logger.error('Worker requires REDIS_URL');
  process.exit(1);
}

const worker = new Worker(QUEUE_NAME, async (job) => sendNow(job.data), {
  connection: { url: env.REDIS_URL },
  concurrency: 5,
  // The gateways are a shared Azure app service; 20 sends/second is polite and
  // well under anything either vendor has flagged.
  limiter: { max: 20, duration: 1000 },
});

worker.on('completed', (job) => logger.debug({ jobId: job.id }, 'job completed'));
worker.on('failed', (job, err) =>
  logger.warn({ jobId: job?.id, attempts: job?.attemptsMade, err: err.message }, 'job failed'),
);

const shutdown = async () => {
  logger.info('worker shutting down');
  await worker.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

logger.info('notification worker started');
