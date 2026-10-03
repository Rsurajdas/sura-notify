import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';

/**
 * Shopify signs webhooks with the app's API secret over the raw request body.
 * The body must not have been parsed or re-serialised first — see app.js,
 * where the webhook route mounts express.raw() ahead of express.json().
 */
export function verifyWebhook(rawBody, hmacHeader) {
  if (!hmacHeader || !rawBody) return false;
  const digest = createHmac('sha256', env.SHOPIFY_API_SECRET).update(rawBody).digest('base64');
  const a = Buffer.from(digest);
  const b = Buffer.from(hmacHeader);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * App Proxy requests are signed differently: parameters sorted, joined with no
 * separator, hex digest in `signature`. This is what proves a call to
 * /apps/sura-notify/* came through Shopify from the storefront and not from a
 * script hitting our origin directly.
 */
export function verifyAppProxy(query) {
  const { signature, ...rest } = query;
  if (!signature) return false;

  const message = Object.keys(rest)
    .sort()
    .map((key) => `${key}=${Array.isArray(rest[key]) ? rest[key].join(',') : rest[key]}`)
    .join('');

  const digest = createHmac('sha256', env.SHOPIFY_API_SECRET).update(message).digest('hex');
  const a = Buffer.from(digest);
  const b = Buffer.from(String(signature));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function appProxyGuard(req, res, next) {
  if (!verifyAppProxy(req.query)) {
    return res.status(401).json({ ok: false, error: 'invalid_signature' });
  }
  next();
}
