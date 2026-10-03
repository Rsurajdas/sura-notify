import { env } from '../config/env.js';
import { requestText, formBody } from '../lib/http.js';
import { logger, maskPhone } from '../lib/logger.js';
import { chunkRecipients } from '../lib/phone.js';
import { toUnicodeHex, isGsm7, estimateSegments, vendorTimestamp } from '../lib/text.js';
import { parseGatewayResponse, ProviderError, Kind, SMS_CODES } from './errors.js';

export const SmsType = { PLAIN: '0', FLASH: '1', UNICODE: '2' };

/** The spec allows 100 numbers per call but recommends 25; we honour the recommendation. */
const BATCH_SIZE = 25;

/**
 * SMSIntegra client.
 *
 * Deliberate choices:
 *  - POST over HTTPS only. The GET endpoint in the spec is plain http:// and
 *    puts uid/pwd in the query string, which would write the account password
 *    into every proxy log between here and Chennai.
 *  - Unicode is auto-detected. Tamil copy silently fails as type=0.
 *  - entityid/tempid are always sent. Without the DLT pair, transactional
 *    traffic to Indian numbers is scrubbed by the operator, not by the gateway,
 *    so it looks like a success here and never arrives.
 */
export const smsProvider = {
  channel: 'sms',

  async send({ to, body, templateId, type, senderId, unicode, schedule }) {
    if (!env.SMS_ENABLED) {
      logger.warn({ to: to.map(maskPhone) }, 'SMS disabled by config — skipping send');
      return { skipped: true, messageIds: [] };
    }

    const recipients = Array.isArray(to) ? to : [to];
    if (recipients.length === 0) throw new ProviderError('No recipients', { kind: Kind.INVALID, channel: 'sms' });

    const useUnicode = unicode ?? !isGsm7(body);
    const text = useUnicode ? toUnicodeHex(body) : body;
    const smsType = type ?? (useUnicode ? SmsType.UNICODE : SmsType.PLAIN);
    const segments = estimateSegments(body, useUnicode);

    if (segments > 3) {
      logger.warn({ segments, templateId }, 'SMS body will cost more than 3 credits per recipient');
    }

    const results = [];
    for (const batch of chunkRecipients(recipients, BATCH_SIZE)) {
      const params = {
        uid: env.SMS_UID,
        pwd: env.SMS_PWD,
        mobile: batch.join(','),
        [env.SMS_POST_TEXT_FIELD]: text,
        sid: senderId ?? env.SMS_SENDER_ID,
        type: smsType,
        entityid: env.SMS_ENTITY_ID,
        tempid: templateId ?? '',
        [env.SMS_POST_TIME_FIELD]: vendorTimestamp(),
      };

      if (schedule) {
        // Vendor format: dt = MM/DD/YYYY, time = hh:mm AM/PM, no seconds.
        params.sched = '1';
        params.dt = schedule.date;
        params.time = schedule.time;
      }

      const raw = await requestText(env.SMS_BASE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        // URLSearchParams handles the encoding the spec asks for. Do NOT
        // pre-encode the body as well — the gateway would store %20 literals.
        body: formBody(params),
      });

      const parsed = parseGatewayResponse(raw, { channel: 'sms', table: SMS_CODES });
      results.push(parsed);

      logger.info(
        { channel: 'sms', templateId, recipients: batch.length, segments, messageIds: parsed.messageIds, partial: parsed.partial },
        'sms submitted',
      );
    }

    return {
      messageIds: results.flatMap((r) => r.messageIds),
      partial: results.some((r) => r.partial),
      segments,
    };
  },

  /** Returns { credits, validityDays } or throws. Used by the low-balance check. */
  async credits() {
    const url = `${env.SMS_CREDIT_URL}?uid=${encodeURIComponent(env.SMS_UID)}&pwd=${encodeURIComponent(env.SMS_PWD)}`;
    const raw = (await requestText(url)).trim();

    if (/^please register|does not match/i.test(raw)) {
      throw new ProviderError('Credit check rejected the credentials', { kind: Kind.AUTH, channel: 'sms', raw });
    }
    const match = raw.match(/^(\d+)\s*-\s*Credit.*?;\s*(\d+)\s*-\s*day/i);
    if (!match) {
      throw new ProviderError('Unrecognised credit-check response', { kind: Kind.RETRYABLE, channel: 'sms', raw: raw.slice(0, 200) });
    }
    return { credits: Number(match[1]), validityDays: Number(match[2]), raw };
  },

  /**
   * Delivery report for one message id. The gateway answers "10 - <html…>";
   * the first five characters are a prefix, not part of the report.
   */
  async deliveryReport(messageId) {
    const url =
      `${env.SMS_DLR_URL}?uid=${encodeURIComponent(env.SMS_UID)}` +
      `&pwd=${encodeURIComponent(env.SMS_PWD)}` +
      `&msgid=${encodeURIComponent(messageId)}` +
      `&dtTimeNow=${encodeURIComponent(vendorTimestamp())}`;

    const raw = (await requestText(url)).trim();
    if (raw.startsWith('10 -')) return { status: 'ok', html: raw.slice(5) };
    if (raw.startsWith('99 -')) {
      throw new ProviderError(raw.slice(5).trim(), { kind: Kind.INVALID, code: 99, channel: 'sms', raw });
    }
    throw new ProviderError('Delivery report unavailable', { kind: Kind.RETRYABLE, channel: 'sms', raw: raw.slice(0, 200) });
  },
};
