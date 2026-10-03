import express from 'express';
import { z } from 'zod';
import { appProxyGuard } from '../shopify/verify.js';
import { requestOtp, verifyOtp, OtpError, Purpose } from '../otp/service.js';
import { store } from '../lib/redis.js';
import { logger } from '../lib/logger.js';

/**
 * Mounted behind a Shopify App Proxy at /apps/sura-notify/*.
 * The storefront calls it same-origin, so there is no CORS to configure and
 * no credential ever reaches the browser.
 */
export const proxyRouter = express.Router();

proxyRouter.use(express.json({ limit: '32kb' }));
proxyRouter.use(appProxyGuard);

/** Per-IP limit on top of the per-phone limits in the OTP service. */
async function ipLimit(req, res, next) {
  const ip = (req.get('X-Forwarded-For') ?? req.ip ?? '').split(',')[0].trim();
  const count = await store.incrWithTtl(`ip:otp:${ip}`, 3600);
  if (count > 20) {
    logger.warn({ ip }, 'ip rate limit hit on otp endpoints');
    return res.status(429).json({ ok: false, error: 'rate_limited', message: 'Too many requests. Try again later.' });
  }
  next();
}

const requestSchema = z.object({
  phone: z.string().min(8).max(20),
  // Captured at request time and carried through to verification, so the
  // customers/create webhook can match the new account to this verification.
  email: z.string().email().optional(),
  purpose: z.enum([Purpose.REGISTRATION]).default(Purpose.REGISTRATION),
});

const verifySchema = z.object({
  phone: z.string().min(8).max(20),
  code: z.string().min(4).max(10),
  purpose: z.enum([Purpose.REGISTRATION]).default(Purpose.REGISTRATION),
});

proxyRouter.post('/otp/request', ipLimit, async (req, res) => {
  const parsed = requestSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'invalid_request', message: 'Enter a valid mobile number' });

  try {
    const { email, ...rest } = parsed.data;
    const result = await requestOtp({ ...rest, context: { email } });
    res.json({ ok: true, ...result });
  } catch (err) {
    respondOtpError(res, err);
  }
});

proxyRouter.post('/otp/verify', ipLimit, async (req, res) => {
  const parsed = verifySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'invalid_request', message: 'Enter the 6-digit code' });

  try {
    const result = await verifyOtp(parsed.data);
    res.json({ ok: true, token: result.token });
  } catch (err) {
    respondOtpError(res, err);
  }
});

function respondOtpError(res, err) {
  if (err instanceof OtpError) {
    const status = err.code === 'cooldown' || err.code === 'rate_limited' ? 429 : 400;
    return res.status(status).json({ ok: false, error: err.code, message: err.message, ...err.meta });
  }
  logger.error({ err }, 'otp endpoint failed');
  return res.status(502).json({ ok: false, error: 'gateway_error', message: 'Could not send the code right now. Try again.' });
}
