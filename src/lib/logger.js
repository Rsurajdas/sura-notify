import pino from 'pino';
import { env, isProd } from '../config/env.js';

// Anything that could carry a credential, an OTP or a full mobile number is
// redacted at the logger level, so no call site can leak it by accident.
export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: [
      'uid', 'pwd', 'password', 'otp', 'code', 'token',
      '*.uid', '*.pwd', '*.password', '*.otp', '*.code', '*.token',
      'req.headers.authorization', 'req.headers["x-shopify-hmac-sha256"]',
    ],
    censor: '[redacted]',
  },
  transport: isProd ? undefined : { target: 'pino-pretty', options: { colorize: true } },
});

/** 9840059095 -> 98****5095 — enough to debug with, not enough to dial. */
export function maskPhone(phone) {
  if (!phone) return '';
  const s = String(phone);
  return s.length <= 6 ? '***' : `${s.slice(0, 4)}****${s.slice(-4)}`;
}

/** Strips uid/pwd out of any vendor URL before it reaches a log line. */
export function safeUrl(url) {
  try {
    const u = new URL(url);
    for (const key of ['uid', 'pwd', 'userid', 'password']) {
      if (u.searchParams.has(key)) u.searchParams.set(key, '***');
    }
    return u.toString();
  } catch {
    return '[unparseable-url]';
  }
}
