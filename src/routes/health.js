import express from 'express';
import { store } from '../lib/redis.js';
import { env } from '../config/env.js';

export const healthRouter = express.Router();

healthRouter.get('/healthz', (_req, res) => res.json({ ok: true }));

healthRouter.get('/readyz', async (_req, res) => {
  const checks = { redis: 'skipped', sms: env.SMS_ENABLED, whatsapp: env.WA_ENABLED };
  if (store.raw) {
    try {
      await store.raw.ping();
      checks.redis = 'ok';
    } catch {
      checks.redis = 'down';
      return res.status(503).json({ ok: false, checks });
    }
  }
  res.json({ ok: true, checks });
});
