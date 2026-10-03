import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

/**
 * Thin Admin API wrapper. Used for two things only: tagging customers whose
 * phone was never verified, and reading an order when a webhook payload is
 * missing a field we need.
 */
async function adminFetch(path, { method = 'GET', body } = {}) {
  if (!env.SHOPIFY_ADMIN_TOKEN) throw new Error('SHOPIFY_ADMIN_TOKEN is not configured');

  const res = await fetch(
    `https://${env.SHOPIFY_SHOP_DOMAIN}/admin/api/${env.SHOPIFY_API_VERSION}${path}`,
    {
      method,
      headers: {
        'X-Shopify-Access-Token': env.SHOPIFY_ADMIN_TOKEN,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    },
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Admin API ${method} ${path} failed: ${res.status} ${text.slice(0, 200)}`);
  }
  return res.status === 204 ? null : res.json();
}

export async function addCustomerTags(customerId, tags) {
  const { customer } = await adminFetch(`/customers/${customerId}.json`);
  const existing = (customer.tags || '').split(',').map((t) => t.trim()).filter(Boolean);
  const merged = [...new Set([...existing, ...tags])].join(', ');
  await adminFetch(`/customers/${customerId}.json`, { method: 'PUT', body: { customer: { id: customerId, tags: merged } } });
  logger.info({ customerId, tags }, 'customer tagged');
}

/** Phone must be in E.164 (+919840059095) for the Admin API to accept it. */
export async function setCustomerPhone(customerId, phone) {
  await adminFetch(`/customers/${customerId}.json`, {
    method: 'PUT',
    body: { customer: { id: customerId, phone } },
  });
  logger.info({ customerId }, 'verified phone attached to customer');
}

export async function getOrder(orderId) {
  const { order } = await adminFetch(`/orders/${orderId}.json`);
  return order;
}
