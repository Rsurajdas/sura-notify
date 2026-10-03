import { env } from '../config/env.js';
import { render } from '../lib/text.js';

/**
 * The single place where "what we send" is defined.
 *
 * Adding a notification later — abandoned cart, refund, back-in-stock — means
 * adding one entry here and nothing else. Nothing outside this file knows what
 * a message says.
 *
 * ⚠ DLT: the `body` strings below are placeholders. Replace each one with the
 * exact text approved on the DLT portal, character for character, including
 * punctuation and the trailing brand suffix. Indian operators match the
 * template hash, so a single changed comma turns into a silent scrub: the
 * gateway still answers "100 - Msg successfully sent" and the SMS never lands.
 *
 * ⚠ WhatsApp: variables are positional. Their order here must match the order
 * of {{1}}, {{2}}… in the Meta-approved template body.
 */

const inr = (amount, currency = 'INR') =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 })
    .format(Number(amount))
    .replace(/\u00A0/g, ' ');

export const Notification = {
  REGISTRATION_OTP: 'registration_otp',
  ORDER_CONFIRMATION: 'order_confirmation',
  SHIPPING_UPDATE: 'shipping_update',
  DELIVERY_OTP: 'delivery_otp',
};

export const catalog = {
  [Notification.REGISTRATION_OTP]: {
    description: 'One-time code for phone verification at registration',
    // OTP must never queue behind a marketing batch, and must never be retried
    // after the code has expired.
    priority: 'high',
    channels: ['sms'],
    sms: {
      templateId: env.DLT_TMPL_REGISTRATION_OTP,
      body: '{{otp}} is your verification code for Sura Books. Valid for {{minutes}} minutes. Do not share it with anyone. - SURA',
      build: (ctx) => ({ otp: ctx.otp, minutes: ctx.minutes }),
    },
  },

  [Notification.ORDER_CONFIRMATION]: {
    description: 'Sent once payment is confirmed',
    priority: 'normal',
    channels: ['sms', 'whatsapp'],
    sms: {
      templateId: env.DLT_TMPL_ORDER_CONFIRMATION,
      body: 'Thank you for your order {{orderName}} of {{amount}} placed on Sura Books. We will notify you when it ships. - SURA',
      build: (ctx) => ({
        orderName: ctx.orderName,
        amount: inr(ctx.totalPrice, ctx.currency),
      }),
    },
    whatsapp: {
      templateId: env.WA_TMPL_ORDER_CONFIRMATION,
      // Positional: {{1}} customer, {{2}} order no, {{3}} items, {{4}} amount, {{5}} status URL
      build: (ctx) => [
        ctx.customerName,
        ctx.orderName,
        String(ctx.itemCount),
        inr(ctx.totalPrice, ctx.currency),
        ctx.statusUrl ?? '',
      ],
    },
  },

  [Notification.SHIPPING_UPDATE]: {
    description: 'Sent when a fulfillment is created',
    priority: 'normal',
    channels: ['whatsapp'],
    whatsapp: {
      templateId: env.WA_TMPL_SHIPPING_UPDATE,
      // {{1}} customer, {{2}} order no, {{3}} courier, {{4}} AWB, {{5}} tracking URL
      build: (ctx) => [
        ctx.customerName,
        ctx.orderName,
        ctx.courier ?? 'our courier partner',
        ctx.trackingNumber ?? '-',
        ctx.trackingUrl ?? '',
      ],
    },
  },

  [Notification.DELIVERY_OTP]: {
    description: 'Code the customer reads out to the delivery agent',
    priority: 'high',
    channels: ['sms'],
    sms: {
      templateId: env.DLT_TMPL_DELIVERY_OTP,
      body: 'Share {{otp}} with the delivery agent to receive order {{orderName}}. Valid for {{minutes}} minutes. Do not share it before delivery. - SURA',
      build: (ctx) => ({ otp: ctx.otp, orderName: ctx.orderName, minutes: ctx.minutes }),
    },
  },
};

/** Resolves one notification + channel into a ready-to-send provider payload. */
export function buildPayload(type, channel, ctx) {
  const entry = catalog[type];
  if (!entry) throw new Error(`Unknown notification type "${type}"`);

  const spec = entry[channel];
  if (!spec) throw new Error(`Notification "${type}" has no ${channel} variant`);

  if (channel === 'sms') {
    return { body: render(spec.body, spec.build(ctx)), templateId: spec.templateId };
  }
  return { variables: spec.build(ctx), templateId: spec.templateId };
}

export function channelsFor(type) {
  const entry = catalog[type];
  if (!entry) throw new Error(`Unknown notification type "${type}"`);
  return entry.channels;
}
