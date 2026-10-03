import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';
import { store } from '../lib/redis.js';
import { normalisePhone } from '../lib/phone.js';
import { logger, maskPhone } from '../lib/logger.js';
import { dispatch } from '../notifications/dispatcher.js';
import { Notification } from '../notifications/catalog.js';

export const Purpose = {
  REGISTRATION: 'registration',
  DELIVERY: 'delivery',
};

export class OtpError extends Error {
  constructor(code, message, meta = {}) {
    super(message);
    this.name = 'OtpError';
    this.code = code;
    this.meta = meta;
  }
}

const key = (purpose, phone) => `otp:${purpose}:${phone}`;
const sendCountKey = (purpose, phone) => `otp:sends:${purpose}:${phone}`;
const cooldownKey = (purpose, phone) => `otp:cooldown:${purpose}:${phone}`;
const verifiedKey = (purpose, phone) => `otp:verified:${purpose}:${phone}`;

/** Codes are never stored in clear text, so a Redis dump is not a list of live OTPs. */
function hash(code, phone, purpose) {
  return createHmac('sha256', env.OTP_SECRET).update(`${purpose}:${phone}:${code}`).digest('hex');
}

function generate() {
  const max = 10 ** env.OTP_LENGTH;
  // Leading zeros are fine and keep the entropy at the full code length.
  return String(randomInt(0, max)).padStart(env.OTP_LENGTH, '0');
}

/**
 * Issues a code and sends it. Rate limits are per phone and enforced here, not
 * in the route, so every caller gets them.
 */
export async function requestOtp({ phone, purpose = Purpose.REGISTRATION, context = {} }) {
  const to = normalisePhone(phone);
  if (!to) throw new OtpError('invalid_phone', 'Enter a valid 10-digit Indian mobile number');

  const cooldown = await store.ttl(cooldownKey(purpose, to));
  if (cooldown > 0) {
    throw new OtpError('cooldown', `Wait ${cooldown} seconds before requesting another code`, { retryAfter: cooldown });
  }

  const sends = await store.incrWithTtl(sendCountKey(purpose, to), 3600);
  if (sends > env.OTP_MAX_SENDS_PER_HOUR) {
    logger.warn({ phone: maskPhone(to), purpose, sends }, 'otp send limit reached');
    throw new OtpError('rate_limited', 'Too many codes requested. Try again in an hour.');
  }

  const code = generate();
  await store.setex(
    key(purpose, to),
    env.OTP_TTL_SECONDS,
    JSON.stringify({ hash: hash(code, to, purpose), attempts: 0, createdAt: Date.now(), context }),
  );
  await store.setex(cooldownKey(purpose, to), env.OTP_RESEND_COOLDOWN_SECONDS, '1');

  const type = purpose === Purpose.DELIVERY ? Notification.DELIVERY_OTP : Notification.REGISTRATION_OTP;
  await dispatch({
    type,
    phone: to,
    context: { ...context, otp: code, minutes: Math.round(env.OTP_TTL_SECONDS / 60) },
    // A resend inside the same window is a genuinely new message, so the key
    // must change — otherwise the duplicate guard would swallow it.
    idempotencyKey: `otp:${purpose}:${to}:${Date.now()}`,
  });

  logger.info({ phone: maskPhone(to), purpose }, 'otp issued');
  return { sent: true, expiresIn: env.OTP_TTL_SECONDS, resendAfter: env.OTP_RESEND_COOLDOWN_SECONDS };
}

/**
 * Verifies a code. Wrong guesses are counted and the record is destroyed once
 * the limit is hit, so an attacker gets OTP_MAX_ATTEMPTS tries per issued code
 * rather than per request.
 */
export async function verifyOtp({ phone, code, purpose = Purpose.REGISTRATION }) {
  const to = normalisePhone(phone);
  if (!to) throw new OtpError('invalid_phone', 'Enter a valid 10-digit Indian mobile number');

  const stored = await store.get(key(purpose, to));
  if (!stored) throw new OtpError('expired', 'That code has expired. Request a new one.');

  const record = JSON.parse(stored);
  const expected = Buffer.from(record.hash, 'hex');
  const actual = Buffer.from(hash(String(code ?? '').trim(), to, purpose), 'hex');
  const match = expected.length === actual.length && timingSafeEqual(expected, actual);

  if (!match) {
    record.attempts += 1;
    const remaining = env.OTP_MAX_ATTEMPTS - record.attempts;

    if (remaining <= 0) {
      await store.del(key(purpose, to));
      logger.warn({ phone: maskPhone(to), purpose }, 'otp attempt limit reached');
      throw new OtpError('too_many_attempts', 'Too many incorrect codes. Request a new one.');
    }

    const ttl = await store.ttl(key(purpose, to));
    await store.setex(key(purpose, to), Math.max(ttl, 1), JSON.stringify(record));
    throw new OtpError('incorrect', 'That code is not correct', { remaining });
  }

  // Single use.
  await store.del(key(purpose, to));
  await store.del(sendCountKey(purpose, to));

  // Remember the verification so the customers/create webhook can confirm the
  // account was actually gated, and issue a signed token for the storefront.
  await store.setex(verifiedKey(purpose, to), 1800, String(Date.now()));

  // Shopify's create_customer form does not carry a phone field, so the new
  // account arrives with an email and nothing else. Indexing the verification
  // by email as well lets the webhook match the two up and write the verified
  // number onto the customer record.
  const email = record.context?.email?.trim().toLowerCase();
  if (email) await store.setex(`otp:verified:email:${email}`, 1800, to);

  logger.info({ phone: maskPhone(to), purpose }, 'otp verified');
  return { verified: true, token: signVerification(to, purpose), context: record.context };
}

export async function wasRecentlyVerified(phone, purpose = Purpose.REGISTRATION) {
  const to = normalisePhone(phone);
  if (!to) return false;
  return (await store.get(verifiedKey(purpose, to))) !== null;
}

/** Returns the verified phone number for an email, or null. */
export async function verifiedPhoneForEmail(email) {
  if (!email) return null;
  return store.get(`otp:verified:email:${email.trim().toLowerCase()}`);
}

/**
 * Short-lived signed proof of verification. The storefront puts it in a hidden
 * field; anything server-side can check it without a round trip to Redis.
 */
export function signVerification(phone, purpose, ttlSeconds = 1800) {
  const payload = Buffer.from(JSON.stringify({ phone, purpose, exp: Date.now() + ttlSeconds * 1000 })).toString('base64url');
  const sig = createHmac('sha256', env.OTP_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function verifyToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  const expected = createHmac('sha256', env.OTP_SECRET).update(payload).digest('base64url');
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;

  const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
  return data.exp > Date.now() ? data : null;
}
