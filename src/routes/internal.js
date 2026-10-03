import express from 'express';
import { timingSafeEqual, createHash } from 'node:crypto';
import { z } from 'zod';
import { env } from '../config/env.js';
import { verifyOtp, OtpError, Purpose } from '../otp/service.js';
import { dispatch } from '../notifications/dispatcher.js';
import { smsProvider, whatsappProvider } from '../providers/index.js';
import { logger } from '../lib/logger.js';

/**
 * Staff and courier-facing endpoints. Not reachable from the storefront —
 * protect with a bearer token and, ideally, an IP allow-list at the edge.
 */
export const internalRouter = express.Router();

internalRouter.use(express.json({ limit: '32kb' }));

internalRouter.use((req, res, next) => {
  const presented = (req.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(env.SHOPIFY_API_SECRET).digest();
  if (!timingSafeEqual(a, b)) return res.status(401).json({ ok: false, error: 'unauthorised' });
  next();
});

/** Delivery agent confirms handover by entering the code the customer received. */
internalRouter.post('/delivery/verify', async (req, res) => {
  const schema = z.object({ phone: z.string(), code: z.string() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'invalid_request' });

  try {
    const result = await verifyOtp({ ...parsed.data, purpose: Purpose.DELIVERY });
    res.json({ ok: true, order: result.context?.orderName ?? null });
  } catch (err) {
    if (err instanceof OtpError) return res.status(400).json({ ok: false, error: err.code, message: err.message });
    throw err;
  }
});

/** Manual resend, e.g. a customer on the phone who never got the confirmation. */
internalRouter.post('/notifications/send', async (req, res) => {
  const schema = z.object({
    type: z.string(),
    phone: z.string(),
    context: z.record(z.any()).default({}),
    channels: z.array(z.enum(['sms', 'whatsapp'])).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'invalid_request' });

  const result = await dispatch(parsed.data);
  res.json({ ok: true, ...result });
});

/** Credit balance for both accounts. Poll this from a cron and alert on it. */
internalRouter.get('/credits', async (_req, res) => {
  const out = {};
  for (const [name, provider] of Object.entries({ sms: smsProvider, whatsapp: whatsappProvider })) {
    try {
      out[name] = await provider.credits();
    } catch (err) {
      out[name] = { error: err.message };
      logger.error({ err, provider: name }, 'credit check failed');
    }
  }
  res.json({ ok: true, ...out });
});

/** Delivery report passthrough for support staff chasing a specific message. */
internalRouter.get('/sms/dlr/:messageId', async (req, res) => {
  try {
    res.json({ ok: true, ...(await smsProvider.deliveryReport(req.params.messageId)) });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});
