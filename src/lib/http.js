import { logger, safeUrl } from './logger.js';

export class HttpError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
  }
}

/**
 * Both gateways answer with plain text, not JSON, and occasionally with an
 * HTML error page when the server is restarting. So we always read the body as
 * text and let the provider classify it.
 */
export async function requestText(url, { method = 'GET', body, headers = {}, timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();

  try {
    const res = await fetch(url, { method, body, headers, signal: controller.signal });
    const text = await res.text();
    logger.debug({ url: safeUrl(url), method, status: res.status, ms: Date.now() - started }, 'gateway call');
    if (!res.ok) {
      throw new HttpError(`Gateway returned HTTP ${res.status}`, { status: res.status, body: text });
    }
    return text;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new HttpError(`Gateway timed out after ${timeoutMs}ms`, { status: 0 });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export function formBody(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    search.append(key, String(value));
  }
  return search.toString();
}
