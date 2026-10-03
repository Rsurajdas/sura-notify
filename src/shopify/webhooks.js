import express from 'express';
import { verifyWebhook } from './verify.js';
import { addCustomerTags, setCustomerPhone } from './admin.js';
import { store } from '../lib/redis.js';
import { logger, maskPhone } from '../lib/logger.js';
import { dispatch } from '../notifications/dispatcher.js';
import { Notification } from '../notifications/catalog.js';
import { requestOtp, wasRecentlyVerified, verifiedPhoneForEmail, Purpose } from '../otp/service.js';
import { env } from '../config/env.js';

export const webhookRouter = express.Router();

/**
 * Raw body is required for HMAC verification, so this router — and only this
 * router — parses with express.raw().
 */
webhookRouter.use(express.raw({ type: 'application/json', limit: '2mb' }));

webhookRouter.post('/:topic(*)', async (req, res) => {
  const hmac = req.get('X-Shopify-Hmac-Sha256');
  const topic = req.get('X-Shopify-Topic') ?? req.params.topic;
  const webhookId = req.get('X-Shopify-Webhook-Id');
  const shop = req.get('X-Shopify-Shop-Domain');

  if (!verifyWebhook(req.body, hmac)) {
    logger.warn({ topic, shop }, 'rejected webhook with bad signature');
    return res.status(401).send('invalid signature');
  }
  if (shop && shop !== env.SHOPIFY_SHOP_DOMAIN) {
    logger.warn({ shop }, 'rejected webhook from unexpected shop');
    return res.status(401).send('unexpected shop');
  }

  // Shopify retries for 48h and can deliver the same event twice. Ack first,
  // then work — a slow handler turns into duplicate deliveries.
  res.status(200).send('ok');

  if (webhookId) {
    const fresh = await store.setnx(`webhook:${webhookId}`, 60 * 60 * 48, '1');
    if (!fresh) return logger.info({ topic, webhookId }, 'duplicate webhook ignored');
  }

  let payload;
  try {
    payload = JSON.parse(req.body.toString('utf8'));
  } catch (err) {
    return logger.error({ err, topic }, 'webhook body was not valid JSON');
  }

  try {
    await route(topic, payload);
  } catch (err) {
    logger.error({ err, topic, webhookId }, 'webhook handler failed');
  }
});

async function route(topic, payload) {
  switch (topic) {
    case 'orders/paid':
    case 'orders/create':
      return onOrderConfirmed(payload);
    case 'fulfillments/create':
      return onFulfillmentCreated(payload);
    case 'customers/create':
      return onCustomerCreated(payload);
    default:
      logger.debug({ topic }, 'no handler for topic');
  }
}

/**
 * Order confirmation, SMS + WhatsApp.
 *
 * Subscribe to orders/paid rather than orders/create unless the store takes
 * cash on delivery — orders/create fires for unpaid drafts and abandoned
 * payment attempts too.
 */
async function onOrderConfirmed(order) {
  const phone = orderPhone(order);
  if (!phone) return logger.warn({ orderId: order.id }, 'order has no phone number — nothing to notify');

  await dispatch({
    type: Notification.ORDER_CONFIRMATION,
    phone,
    context: {
      orderName: order.name,
      orderId: order.id,
      customerName: customerFirstName(order),
      itemCount: (order.line_items ?? []).reduce((n, li) => n + (li.quantity ?? 0), 0),
      totalPrice: order.current_total_price ?? order.total_price,
      currency: order.currency ?? 'INR',
      statusUrl: order.order_status_url ?? '',
    },
    // Keyed on the order, so a webhook replay or a paid→create overlap cannot
    // send two confirmations for the same purchase.
    idempotencyKey: `order-confirmation:${order.id}`,
  });
}

/**
 * Fulfillment: a WhatsApp shipping update, plus a delivery OTP by SMS.
 * The OTP is issued here so the customer has it before the agent arrives; the
 * courier-facing verification endpoint lives in routes/delivery.js.
 */
async function onFulfillmentCreated(fulfillment) {
  const phone = fulfillment.destination?.phone
    ?? fulfillment.shipping_address?.phone
    ?? fulfillment.email_phone
    ?? null;

  if (!phone) return logger.warn({ fulfillmentId: fulfillment.id }, 'fulfillment has no phone number');

  const orderName = fulfillment.name ?? `#${fulfillment.order_id}`;

  await dispatch({
    type: Notification.SHIPPING_UPDATE,
    phone,
    context: {
      orderName,
      customerName: fulfillment.destination?.first_name ?? 'Customer',
      courier: fulfillment.tracking_company ?? null,
      trackingNumber: fulfillment.tracking_number ?? null,
      trackingUrl: fulfillment.tracking_url ?? (fulfillment.tracking_urls ?? [])[0] ?? '',
    },
    idempotencyKey: `shipping-update:${fulfillment.id}`,
  });

  try {
    await requestOtp({
      phone,
      purpose: Purpose.DELIVERY,
      context: { orderName, orderId: fulfillment.order_id, fulfillmentId: fulfillment.id },
    });
  } catch (err) {
    // A cooldown or rate-limit here is expected on a split shipment; it is not
    // a failure worth retrying the whole webhook for.
    logger.warn({ err: err.message, fulfillmentId: fulfillment.id }, 'delivery OTP not issued');
  }
}

/**
 * Shopify owns account creation, so the storefront gate can be bypassed by
 * anyone posting straight to /account. This is the server-side truth check:
 * if the phone on a new account was not verified in the last 30 minutes, the
 * customer is tagged so staff and the theme can treat them accordingly.
 */
async function onCustomerCreated(customer) {
  const phoneOnRecord = customer.phone ?? customer.default_address?.phone;

  // Match on the phone if Shopify captured one, otherwise on the email the
  // customer verified with.
  const verifiedPhone = phoneOnRecord
    ? ((await wasRecentlyVerified(phoneOnRecord, Purpose.REGISTRATION)) ? phoneOnRecord : null)
    : await verifiedPhoneForEmail(customer.email);

  logger.info(
    { customerId: customer.id, phone: maskPhone(verifiedPhone ?? phoneOnRecord), verified: Boolean(verifiedPhone) },
    'customer created',
  );

  if (!env.SHOPIFY_ADMIN_TOKEN) return;

  if (verifiedPhone) {
    // Write the number onto the customer so every later order has a phone to
    // notify, then tag the account.
    if (!phoneOnRecord) {
      await setCustomerPhone(customer.id, `+${verifiedPhone}`).catch((err) =>
        logger.warn({ err: err.message, customerId: customer.id }, 'could not attach verified phone'),
      );
    }
    await addCustomerTags(customer.id, ['phone-verified']);
  } else {
    await addCustomerTags(customer.id, ['phone-unverified']);
  }
}

function orderPhone(order) {
  return (
    order.shipping_address?.phone
    ?? order.customer?.phone
    ?? order.phone
    ?? order.billing_address?.phone
    ?? null
  );
}

function customerFirstName(order) {
  return order.customer?.first_name ?? order.shipping_address?.first_name ?? 'Customer';
}
