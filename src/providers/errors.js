/**
 * Both gateways reply with a leading numeric code in a plain-text body.
 * Classifying that code is what decides whether the dispatcher retries, gives
 * up quietly, or pages someone — so the mapping lives in one place.
 *
 *   retryable  – transient; the queue will back off and try again
 *   invalid    – the request itself is wrong; retrying cannot help
 *   credit     – account is out of credit or expired; alert, do not retry
 *   auth       – credentials or profile problem; alert, do not retry
 */
export const Kind = {
  RETRYABLE: 'retryable',
  INVALID: 'invalid',
  CREDIT: 'credit',
  AUTH: 'auth',
};

export class ProviderError extends Error {
  constructor(message, { kind = Kind.RETRYABLE, code = null, raw = null, channel } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.code = code;
    this.raw = raw;
    this.channel = channel;
  }

  get retryable() {
    return this.kind === Kind.RETRYABLE;
  }

  /** True when a human needs to know now — credit and credentials both stop all traffic. */
  get alertable() {
    return this.kind === Kind.CREDIT || this.kind === Kind.AUTH;
  }
}

/** SMSIntegra HTTP API, "Return values" table. */
export const SMS_CODES = {
  49: [Kind.INVALID, 'Consecutive numbers not permitted'],
  60: [Kind.INVALID, 'Blocked content — message contains a flagged word'],
  70: [Kind.RETRYABLE, 'Duplicate submission guard triggered'],
  72: [Kind.AUTH, 'Sender ID deactivated'],
  80: [Kind.INVALID, 'URL contains invalid characters'],
  82: [Kind.CREDIT, 'Credit validity expired'],
  86: [Kind.AUTH, 'Invalid sender ID'],
  91: [Kind.RETRYABLE, 'Unspecified gateway error'],
  98: [Kind.AUTH, 'Invalid profile'],
  99: [Kind.AUTH, 'Invalid username or password'],
  102: [Kind.AUTH, 'Login deactivated'],
  103: [Kind.CREDIT, 'Credit exhausted'],
  105: [Kind.INVALID, 'Number must start with 91 and be 12 digits'],
  112: [Kind.INVALID, 'Invalid mobile number(s)'],
};

/** ChatIntegra WhatsApp API, "Return values" table. */
export const WA_CODES = {
  80: [Kind.INVALID, 'Invalid hex format for Unicode message'],
  82: [Kind.CREDIT, 'Credit validity expired'],
  91: [Kind.RETRYABLE, 'Unspecified gateway error'],
  96: [Kind.INVALID, 'Invalid mobile number'],
  98: [Kind.AUTH, 'Invalid profile'],
  99: [Kind.AUTH, 'Invalid username or password'],
  102: [Kind.AUTH, 'Login deactivated'],
  103: [Kind.CREDIT, 'Credit exhausted'],
  104: [Kind.AUTH, 'Account is not a paid ChatIntegra user'],
};

/**
 * Parses "100 - Msg successfully sent. MsgID(s)#123,124" style responses.
 * An HTML body means the gateway is restarting — both specs say so — and is
 * always treated as retryable.
 */
export function parseGatewayResponse(text, { channel, table }) {
  const raw = (text ?? '').trim();

  if (!raw) {
    throw new ProviderError('Empty response from gateway', { kind: Kind.RETRYABLE, channel, raw });
  }

  if (raw.toUpperCase().startsWith('<HTML') || raw.toUpperCase().startsWith('<!DOCTYPE')) {
    throw new ProviderError('Gateway is down or restarting', { kind: Kind.RETRYABLE, channel, raw: raw.slice(0, 200) });
  }

  const match = raw.match(/^(\d{2,3})/);
  if (!match) {
    throw new ProviderError('Unrecognised gateway response', { kind: Kind.RETRYABLE, channel, raw: raw.slice(0, 200) });
  }

  const code = Number(match[1]);

  if (code === 100 || code === 101) {
    return {
      code,
      partial: code === 101,
      messageIds: extractMessageIds(raw),
      raw,
    };
  }

  const [kind, description] = table[code] ?? [Kind.RETRYABLE, 'Unknown gateway code'];
  throw new ProviderError(`${description} (code ${code})`, { kind, code, channel, raw: raw.slice(0, 300) });
}

function extractMessageIds(raw) {
  // SMS: "MsgID(s)#123,124"  WhatsApp: "MsgID#2201898"
  const match = raw.match(/MsgID(?:\(s\))?#\s*([\d,\s]+)/i);
  if (!match) return [];
  return match[1].split(',').map((id) => id.trim()).filter(Boolean);
}
