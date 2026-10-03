import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');
const int = (d) => z.coerce.number().int().default(d);

const schema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: int(3000),
  LOG_LEVEL: z.string().default('info'),
  REDIS_URL: z.string().optional(),

  SHOPIFY_SHOP_DOMAIN: z.string(),
  SHOPIFY_API_SECRET: z.string().min(1),
  SHOPIFY_ADMIN_TOKEN: z.string().optional(),
  SHOPIFY_API_VERSION: z.string().default('2025-07'),

  SMS_ENABLED: bool.default('true'),
  SMS_BASE_URL: z.string().url(),
  SMS_GET_BASE_URL: z.string().url(),
  SMS_CREDIT_URL: z.string().url(),
  SMS_DLR_URL: z.string().url(),
  SMS_UID: z.string().min(1),
  SMS_PWD: z.string().min(1),
  SMS_SENDER_ID: z.string().max(6),
  SMS_ENTITY_ID: z.string().default(''),
  SMS_POST_TEXT_FIELD: z.string().default('txt'),
  SMS_POST_TIME_FIELD: z.string().default('dtNow'),

  WA_ENABLED: bool.default('true'),
  WA_BASE_URL: z.string().url(),
  WA_CREDIT_URL: z.string().url(),
  WA_UID: z.string().min(1),
  WA_PWD: z.string().min(1),
  WA_INBOUND_SECRET: z.string().optional(),

  DLT_TMPL_REGISTRATION_OTP: z.string().default(''),
  DLT_TMPL_ORDER_CONFIRMATION: z.string().default(''),
  DLT_TMPL_DELIVERY_OTP: z.string().default(''),
  WA_TMPL_ORDER_CONFIRMATION: z.string().default(''),
  WA_TMPL_SHIPPING_UPDATE: z.string().default(''),

  OTP_SECRET: z.string().min(16),
  OTP_LENGTH: int(6),
  OTP_TTL_SECONDS: int(300),
  OTP_RESEND_COOLDOWN_SECONDS: int(60),
  OTP_MAX_ATTEMPTS: int(5),
  OTP_MAX_SENDS_PER_HOUR: int(5),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === 'production';
