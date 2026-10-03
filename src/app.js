import express from 'express';
import { webhookRouter } from './shopify/webhooks.js';
import { proxyRouter } from './routes/proxy.js';
import { internalRouter } from './routes/internal.js';
import { inboundRouter } from './routes/inbound.js';
import { healthRouter } from './routes/health.js';
import { logger } from './lib/logger.js';

export function createApp() {
  const app = express();

  // Behind a load balancer or Cloudflare; needed for correct client IPs.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(healthRouter);

  // Webhooks must be mounted before any JSON body parser: HMAC verification
  // needs the untouched raw body.
  app.use('/webhooks/shopify', webhookRouter);

  app.use('/proxy', proxyRouter);      // Shopify App Proxy -> /apps/sura-notify/*
  app.use('/internal', internalRouter); // staff + courier, bearer token
  app.use('/inbound', inboundRouter);   // ChatIntegra callbacks

  app.use((_req, res) => res.status(404).json({ ok: false, error: 'not_found' }));

  app.use((err, _req, res, _next) => {
    logger.error({ err }, 'unhandled error');
    res.status(500).json({ ok: false, error: 'internal_error' });
  });

  return app;
}
