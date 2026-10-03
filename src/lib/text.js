/**
 * Message-body helpers shared by both providers.
 */

/**
 * Port of the vendor's C# ConvertToUnicode: UTF-16 code units, byte-swapped to
 * big-endian, rendered as an uppercase hex string. Required for Tamil (and any
 * non-GSM) copy, sent with SMS type=2 / WhatsApp txtType=U.
 */
export function toUnicodeHex(text) {
  let hex = '';
  for (let i = 0; i < text.length; i += 1) {
    hex += text.charCodeAt(i).toString(16).padStart(4, '0');
  }
  return hex.toUpperCase();
}

/** GSM-7 is what the gateway bills against; anything outside it forces Unicode. */
const GSM7 =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM7_EXT = '^{}\\[~]|€';

export function isGsm7(text) {
  return [...text].every((ch) => GSM7.includes(ch) || GSM7_EXT.includes(ch));
}

/**
 * Credit estimate, per the SMSIntegra spec: 160 chars = 1 credit for plain
 * text, 153 per part once it concatenates. Unicode halves those numbers.
 * Used to warn at build time when a DLT body is about to cost 3 credits.
 */
export function estimateSegments(text, unicode = false) {
  const len = unicode ? text.length : [...text].reduce((n, ch) => n + (GSM7_EXT.includes(ch) ? 2 : 1), 0);
  const single = unicode ? 70 : 160;
  const multi = unicode ? 67 : 153;
  return len <= single ? 1 : Math.ceil(len / multi);
}

/**
 * Renders an approved DLT template body. Placeholders are {{name}}.
 * Everything outside the placeholders must match the registered text
 * character-for-character or the operator will scrub the message.
 */
export function render(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const value = vars[key];
    if (value === undefined || value === null) {
      throw new Error(`Missing template variable "${key}"`);
    }
    return String(value);
  });
}

/** Vendor timestamp format: mm-dd-yyyy HH:MM:SS AM/PM (their dtTimeNow/dtNow). */
export function vendorTimestamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const h24 = date.getHours();
  const ampm = h24 >= 12 ? 'PM' : 'AM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${p(date.getMonth() + 1)}-${p(date.getDate())}-${date.getFullYear()} ` +
    `${p(h12)}:${p(date.getMinutes())}:${p(date.getSeconds())} ${ampm}`;
}
