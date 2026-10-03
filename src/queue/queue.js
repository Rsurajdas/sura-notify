import { Queue } from 'bullmq';
import { env } from '../config/env.js';
import { store } from '../lib/redis.js';
import { logger } from '../lib/logger.js';

export const QUEUE_NAME = 'sura-notifications';

/**
 * Retry policy: five attempts over roughly ten minutes.
 * 5s → 15s → 45s → 135s → 405s. That covers a gateway restart (the <HTML>
 * response both specs warn about) without holding an OTP past its own TTL —
 * high-priority jobs override this with a shorter ladder in dispatch().
 */
export const defaultJobOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: { age: 86400, count: 5000 },
  removeOnFail: { age: 604800 },
};

let queue = null;

if (env.REDIS_URL) {
  queue = new Queue(QUEUE_NAME, { connection: { url: env.REDIS_URL }, defaultJobOptions });
} else {
  logger.warn('No REDIS_URL — notifications will be sent inline with no retry');
}

export function getQueue() {
  return queue;
}

export { store };
