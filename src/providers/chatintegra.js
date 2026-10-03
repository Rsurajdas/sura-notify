import { randomUUID } from 'node:crypto';
import { env } from '../config/env.js';
import { requestText, formBody } from '../lib/http.js';
import { logger, maskPhone } from '../lib/logger.js';
import { chunkRecipients } from '../lib/phone.js';
import { toUnicodeHex, isGsm7 } from '../lib/text.js';
import { parseGatewayResponse, ProviderError, Kind, WA_CODES } from './errors.js';

/** ChatIntegra caps a single SendMessage call at 10 numbers. */
const BATCH_SIZE = 10;

export const MsgType = {
  TEXT: 'Text',
  IMAGE: 'Image',
  VIDEO: 'Video',
  DOCUMENT: 'Document',
  LOCATION: 'Location',
  MUSIC: 'Music',
};

/**
 * ChatIntegra (WhatsApp) client.
 *
 * Two things the spec makes easy to get wrong:
 *  - `templateinfo` is `templateid~v1~v2~v3`. Because "~" is the separator, a
 *    variable containing "~" would silently shift every later variable. We
 *    reject those instead of sending a mangled message.
 *  - `tag` must never repeat. It is the gateway's duplicate guard, so we pass
 *    our own idempotency key and reuse it across retries of the same job —
 *    that is what stops a retry from sending a second order confirmation.
 */
export const whatsappProvider = {
  channel: 'whatsapp',

  async send({
    to,
    body = '',
    templateId,
    variables = [],
    msgType = MsgType.TEXT,
    mediaType = '',
    mediaData = '',
    location,
    waJson,
    optionType,
    unicode,
    idempotencyKey,
  }) {
    if (!env.WA_ENABLED) {
      logger.warn({ to: (Array.isArray(to) ? to : [to]).map(maskPhone) }, 'WhatsApp disabled by config — skipping send');
      return { skipped: true, messageIds: [] };
    }

    const recipients = Array.isArray(to) ? to : [to];
    if (recipients.length === 0) throw new ProviderError('No recipients', { kind: Kind.INVALID, channel: 'whatsapp' });

    const useUnicode = unicode ?? (body ? !isGsm7(body) : false);
    const text = useUnicode ? toUnicodeHex(body) : body;

    const templateInfo = templateId ? buildTemplateInfo(templateId, variables) : undefined;
    const tag = idempotencyKey ?? randomUUID();

    const results = [];
    for (const [index, batch] of chunkRecipients(recipients, BATCH_SIZE).entries()) {
      const params = {
        uid: env.WA_UID,
        pwd: env.WA_PWD,
        mobile: batch.join(','),
        txt: text,
        msgtype: msgType,
        txtType: useUnicode ? 'U' : 'P',
        mediatype: mediaType,
        mediadata: mediaData,
        tag: index === 0 ? tag : `${tag}-${index}`,
      };

      if (templateInfo) params.templateinfo = templateInfo;
      if (waJson) params.wajson = typeof waJson === 'string' ? waJson : JSON.stringify(waJson);
      if (optionType) params.optiontype = optionType;
      if (location) {
        params.latitude = location.latitude;
        params.longitude = location.longitude;
        params.loc = location.name;
        params.locaddress = location.address;
      }

      const raw = await requestText(`${env.WA_BASE_URL}/SendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formBody(params),
      });

      const parsed = parseGatewayResponse(raw, { channel: 'whatsapp', table: WA_CODES });
      results.push(parsed);

      logger.info(
        { channel: 'whatsapp', templateId, recipients: batch.length, messageIds: parsed.messageIds, partial: parsed.partial },
        'whatsapp submitted',
      );
    }

    return {
      messageIds: results.flatMap((r) => r.messageIds),
      partial: results.some((r) => r.partial),
      tag,
    };
  },

  async credits() {
    const url = `${env.WA_CREDIT_URL}?uid=${encodeURIComponent(env.WA_UID)}&pwd=${encodeURIComponent(env.WA_PWD)}`;
    const raw = (await requestText(url)).trim();
    if (/^please register|does not match/i.test(raw)) {
      throw new ProviderError('Credit check rejected the credentials', { kind: Kind.AUTH, channel: 'whatsapp', raw });
    }
    const match = raw.match(/^(\d+)\s*-\s*Credit.*?;\s*(\d+)\s*-\s*day/i);
    if (!match) {
      throw new ProviderError('Unrecognised credit-check response', { kind: Kind.RETRYABLE, channel: 'whatsapp', raw: raw.slice(0, 200) });
    }
    return { credits: Number(match[1]), validityDays: Number(match[2]), raw };
  },
};

function buildTemplateInfo(templateId, variables) {
  for (const value of variables) {
    if (String(value).includes('~')) {
      throw new ProviderError(
        'Template variable contains "~", which is the templateinfo separator',
        { kind: Kind.INVALID, channel: 'whatsapp' },
      );
    }
    if (/[\r\n]/.test(String(value))) {
      throw new ProviderError('Template variable contains a newline', { kind: Kind.INVALID, channel: 'whatsapp' });
    }
  }
  return [templateId, ...variables].join('~');
}
