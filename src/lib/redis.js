import Redis from 'ioredis';
import { env } from '../config/env.js';
import { logger } from './logger.js';

/**
 * Redis backs the OTP store, rate limits, webhook de-duplication and the retry
 * queue. If REDIS_URL is unset the app falls back to an in-process map so it
 * still boots on a laptop — never run production that way: OTPs would not
 * survive a restart and rate limits would not hold across instances.
 */
let client = null;

if (env.REDIS_URL) {
  client = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: true });
  client.on('error', (err) => logger.error({ err }, 'redis error'));
} else {
  logger.warn('REDIS_URL not set — using in-memory store (development only)');
}

const memory = new Map();

function sweep() {
  const now = Date.now();
  for (const [key, entry] of memory) if (entry.expires && entry.expires < now) memory.delete(key);
}

export const store = {
  isMemory: !client,

  async get(key) {
    if (client) return client.get(key);
    sweep();
    return memory.get(key)?.value ?? null;
  },

  async setex(key, ttlSeconds, value) {
    if (client) return client.set(key, value, 'EX', ttlSeconds);
    memory.set(key, { value, expires: Date.now() + ttlSeconds * 1000 });
    return 'OK';
  },

  /** Set only if absent. Returns true when this call created the key. */
  async setnx(key, ttlSeconds, value) {
    if (client) return (await client.set(key, value, 'EX', ttlSeconds, 'NX')) === 'OK';
    sweep();
    if (memory.has(key)) return false;
    memory.set(key, { value, expires: Date.now() + ttlSeconds * 1000 });
    return true;
  },

  async del(key) {
    if (client) return client.del(key);
    return memory.delete(key) ? 1 : 0;
  },

  /** Increment with a TTL applied on first write. Returns the new count. */
  async incrWithTtl(key, ttlSeconds) {
    if (client) {
      const count = await client.incr(key);
      if (count === 1) await client.expire(key, ttlSeconds);
      return count;
    }
    sweep();
    const entry = memory.get(key);
    if (!entry) {
      memory.set(key, { value: '1', expires: Date.now() + ttlSeconds * 1000 });
      return 1;
    }
    entry.value = String(Number(entry.value) + 1);
    return Number(entry.value);
  },

  async ttl(key) {
    if (client) return client.ttl(key);
    const entry = memory.get(key);
    if (!entry) return -2;
    return Math.max(0, Math.ceil((entry.expires - Date.now()) / 1000));
  },

  raw: client,
};
