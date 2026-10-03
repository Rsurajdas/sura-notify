/**
 * Both vendors want bare digits with the country code and no "+".
 * SMSIntegra return code 105 is explicit: the number must start with 91 and be
 * 12 digits long. Shopify hands us anything from "+91 98400 59095" to
 * "09840059095", so every number is normalised here before it leaves the app.
 */
const DEFAULT_CC = '91';

export function normalisePhone(input, countryCode = DEFAULT_CC) {
  if (!input) return null;
  let digits = String(input).replace(/\D/g, '');
  if (!digits) return null;

  // 00-prefixed international form
  if (digits.startsWith('00')) digits = digits.slice(2);

  // Indian national format: leading 0 or bare 10 digits
  if (countryCode === '91') {
    if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
    if (digits.length === 10) digits = countryCode + digits;
    if (digits.length !== 12 || !digits.startsWith('91')) return null;
    // Indian mobiles start 6-9 after the country code
    if (!/^91[6-9]\d{9}$/.test(digits)) return null;
    return digits;
  }

  if (digits.length < 8 || digits.length > 15) return null;
  return digits;
}

export function isValidPhone(input, countryCode = DEFAULT_CC) {
  return normalisePhone(input, countryCode) !== null;
}

/** SMSIntegra allows 100 per call but recommends 25; ChatIntegra caps at 10. */
export function chunkRecipients(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}
