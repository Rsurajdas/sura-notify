import { randomUUID } from 'node:crypto';
import { providers } from '../providers/index.js';
import { ProviderError } from '../providers/errors.js';
import { buildPayload, channelsFor, catalog } from './catalog.js';
import { normalisePhone } from '../lib/phone.js';
import { logger, maskPhone } from '../lib/logger.js';
import { getQueue } from '../queue/queue.js';
import { store } from '../lib/redis.js';

/**
 * Public entry point for the whole service: everything that wants to notify a
 * customer calls dispatch() and nothing else.
 *
 *   await dispatch({ type: Notification.ORDER_CONFIRMATION, phone, context, idempotencyKey })
 *
 * It normalises the number, picks the channels from the catalog, and hands each
 * one to the queue. If Redis is absent it falls back to sending inline so the
 * service still works in development — with no retries.
 */
export async function dispatch({ type, phone, context = {}, channels, idempotencyKey = randomUUID() }) {
  const to = normalisePhone(phone);
  if (!to) {
    logger.warn({ type, phone: maskPhone(phone) }, 'dropping notification — unusable phone number');
    return { dispatched: [], skipped: ['invalid_phone'] };
  }

  const targets = channels ?? channelsFor(type);
  const priority = catalog[type]?.priority ?? 'normal';
  const queue = getQueue();
  const dispatched = [];

  for (const channel of targets) {
    const job = { type, channel, to, context, idempotencyKey: `${idempotencyKey}:${channel}` };

    if (!queue) {
      await sendNow(job);
      dispatched.push(channel);
      continue;
    }

    await queue.add(`${type}:${channel}`, job, {
      jobId: job.idempotencyKey,
      // OTPs are worthless once expired: fail fast rather than deliver a code
      // the customer can no longer use.
      ...(priority === 'high' ? { attempts: 3, backoff: { type: 'fixed', delay: 3000 }, priority: 1 } : {}),
    });
    dispatched.push(channel);
  }

  logger.info({ type, channels: dispatched, to: maskPhone(to), idempotencyKey }, 'notification dispatched');
  return { dispatched, skipped: [] };
}

/**
 * Executes one queued job. Exported for the worker and for inline fallback.
 * Throwing signals BullMQ to retry; returning marks the job done.
 */
export async function sendNow({ type, channel, to, context, idempotencyKey }) {
  // Belt and braces on top of BullMQ's jobId: a duplicate webhook replay that
  // arrives after the original job was cleaned up still cannot double-send.
  const guard = `sent:${idempotencyKey}`;
  const fresh = await store.setnx(guard, 60 * 60 * 24 * 3, '1');
  if (!fresh) {
    logger.info({ type, channel, idempotencyKey }, 'duplicate suppressed');
    return { duplicate: true };
  }

  try {
    const provider = providers[channel];
    const payload = buildPayload(type, channel, context);
    const result = await provider.send({ to, idempotencyKey, ...payload });

    logger.info({ type, channel, to: maskPhone(to), messageIds: result.messageIds }, 'notification sent');
    return result;
  } catch (err) {
    // Release the guard so a retry is allowed to run.
    await store.del(guard);

    if (err instanceof ProviderError) {
      const level = err.alertable ? 'error' : err.retryable ? 'warn' : 'error';
      logger[level](
        { type, channel, to: maskPhone(to), code: err.code, kind: err.kind, raw: err.raw },
        `notification failed: ${err.message}`,
      );

      if (err.alertable) await raiseAlert(err);

      // Non-retryable failures are swallowed: re-throwing would burn four more
      // attempts on a request that can never succeed.
      if (!err.retryable) return { failed: true, kind: err.kind, code: err.code };
    } else {
      logger.error({ err, type, channel }, 'notification failed with an unexpected error');
    }

    throw err;
  }
}

/**
 * Credit exhaustion and bad credentials stop every message on the account, so
 * they need a human, not a retry. Wire this to whatever the team already
 * watches — Slack webhook, email, Sentry. Debounced to once per hour per kind.
 */
async function raiseAlert(err) {
  const key = `alert:${err.channel}:${err.kind}`;
  const fresh = await store.setnx(key, 3600, '1');
  if (!fresh) return;
  logger.error({ channel: err.channel, kind: err.kind, code: err.code }, `ALERT: ${err.message}`);
  // TODO: POST to the team's alerting webhook here.
}
