# sura-notify

SMS and WhatsApp notifications for the Sura Books Shopify store, on SMSIntegra
(SMS) and ChatIntegra (WhatsApp).

Covers: order confirmation SMS + WhatsApp, registration OTP SMS, delivery OTP
SMS, shipping notification WhatsApp — with one dispatch path, one retry policy
and one place where message content is defined.

---

## Why this is a separate service

SMSIntegra and ChatIntegra both authenticate with `uid` and `pwd` as ordinary
request parameters. There is no token, no scope, no per-key revocation. Anything
that can call those endpoints can send messages on the account until the credits
run out.

A Shopify theme has nowhere to hide that. Liquid renders to the browser, theme
settings are readable via the Storefront API, and `assets/*.js` is a public
file. So the theme never calls a gateway; it calls this service through a
Shopify App Proxy, and this service holds the credentials.

```
Storefront (Minimog theme)
      │  POST /apps/sura-notify/otp/request        ← same-origin, Shopify-signed
      ▼
Shopify App Proxy ──────────────► sura-notify  ──► SMSIntegra   (SMS)
                                     ▲         └─► ChatIntegra  (WhatsApp)
Shopify webhooks ────────────────────┘
  orders/paid · fulfillments/create · customers/create
```

## Layout

```
src/
  config/env.js            validated env; the app refuses to boot half-configured
  lib/
    phone.js               normalises to 91XXXXXXXXXX (gateway code 105)
    text.js                DLT template rendering, Unicode hex, credit estimate
    redis.js               OTP store, rate limits, dedupe (in-memory fallback)
    http.js  logger.js      timeouts; credential/OTP redaction
  providers/
    errors.js              every gateway return code → retry / drop / alert
    smsintegra.js          SMS send, credit check, delivery report
    chatintegra.js         WhatsApp send, credit check
  notifications/
    catalog.js             ← the only file that knows what a message says
    dispatcher.js          normalise → queue → send → classify → alert
  otp/service.js           issue, verify, rate-limit, sign
  shopify/
    verify.js              webhook HMAC + App Proxy signature
    webhooks.js            orders/paid, fulfillments/create, customers/create
    admin.js               customer tagging and phone attachment
  queue/                   BullMQ queue + worker
  routes/                  proxy (storefront) · internal (staff) · inbound (WA)
theme/
  snippets/sura-phone-verify.liquid
  assets/sura-phone-verify.{js,css}
```

## Adding a notification later

One entry in `src/notifications/catalog.js`, nothing else:

```js
[Notification.BACK_IN_STOCK]: {
  channels: ['whatsapp'],
  whatsapp: {
    templateId: env.WA_TMPL_BACK_IN_STOCK,
    build: (ctx) => [ctx.customerName, ctx.productTitle, ctx.productUrl],
  },
},
```

Then `dispatch({ type: Notification.BACK_IN_STOCK, phone, context })` from
wherever the event happens.

---

## Before any of this works: DLT and Meta

Neither of these is a code problem, both take days, and both cause the same
symptom — the gateway replies `100 - Msg successfully sent` and nothing arrives.

**SMS (TRAI DLT).** Sura Publications must be registered as a Principal Entity,
with a registered header (the 6-character sender ID) and an approved content
template per message. Put the entity ID in `SMS_ENTITY_ID` and each template ID
in the matching `DLT_TMPL_*` var. The `body` strings in `catalog.js` are
placeholders: replace each with the approved text **character for character**.
Operators match a hash of the template, so one changed comma means the message
is scrubbed downstream — after the gateway has already said it succeeded.

Variable parts must be `{#var#}` in the registered template and `{{name}}` here,
in the same positions and the same order.

**WhatsApp (Meta).** Order confirmation and shipping update are business-initiated
messages outside the 24-hour window, so each needs an approved template. The
`build()` function returns variables **positionally** — its array order must
match `{{1}}`, `{{2}}`… in the approved body. ChatIntegra joins them with `~`,
which is why the provider rejects any variable containing `~` or a newline
rather than sending a silently shifted message.

---

## Setup

```bash
cp .env.example .env     # fill in credentials
npm install
npm start                # API
npm run worker           # queue worker (separate process)
```

**Shopify custom app** (Settings → Apps → Develop apps):

- Admin API scopes: `read_orders`, `read_customers`, `write_customers`,
  `read_fulfillments`
- Webhooks → `orders/paid`, `fulfillments/create`, `customers/create`,
  all pointing at `https://<host>/webhooks/shopify`
- App Proxy → subpath prefix `apps`, subpath `sura-notify`,
  proxy URL `https://<host>/proxy`
- Copy the app's API secret into `SHOPIFY_API_SECRET` — it signs both the
  webhooks and the proxy requests

**Theme**, in `templates/customers/register.liquid`, inside the
`{% form 'create_customer' %}` block and after the email field:

```liquid
{% render 'sura-phone-verify', form_id: 'create_customer' %}
```

Copy `theme/snippets/*` and `theme/assets/*` into the theme. Naming follows the
existing `sura-` convention, registers `<sura-phone-verify>` via
`customElements.define`, and declares its own CSS/JS rather than joining a
global bundle.

**Secrets.** `.env` is for local work only. In production use the platform's
secret store (Render/Railway env groups, AWS Secrets Manager, Azure Key Vault) —
never the repo, never a theme setting, never a Shopify metafield. Rotate both
gateway passwords on a schedule; because they are sent as request parameters,
treat any leak into a log or a bug report as a full compromise. The logger
redacts `uid`/`pwd`/`otp`/`token` and masks phone numbers, so a stray
`logger.info(params)` cannot undo that.

---

## How the flows actually run

**Order confirmation.** `orders/paid` → HMAC checked → 200 returned immediately
(Shopify retries slow handlers, which is how duplicates happen) → dedupe on
`X-Shopify-Webhook-Id` → one job per channel, both keyed
`order-confirmation:<order_id>`. BullMQ's `jobId` plus a Redis guard in
`sendNow()` means a replay, or an `orders/create` / `orders/paid` overlap,
cannot bill a second message.

Subscribe to `orders/paid`, not `orders/create` — `orders/create` fires on
unpaid drafts and abandoned payment attempts too. If Sura Books takes cash on
delivery, use both and let the idempotency key collapse them.

**Registration OTP.** Storefront → App Proxy → `requestOtp()`. The code is
6 digits from `crypto.randomInt`, stored only as an HMAC-SHA256 hash, TTL 5
minutes, single use, 5 wrong guesses before the record is destroyed, 60-second
resend cooldown, 5 sends per phone per hour, 20 requests per IP per hour.
Comparison is `timingSafeEqual`.

Shopify owns account creation, so the storefront gate is a courtesy — anyone can
POST straight to `/account`. The real check is the `customers/create` webhook:
it looks for a verification against the phone, or against the email if Shopify
captured no phone, then tags the customer `phone-verified` or
`phone-unverified` and writes the verified number onto the record so later
orders have something to notify. Decide with the client what an unverified
account is allowed to do; tagging is the hook for that.

**Shipping.** `fulfillments/create` → WhatsApp shipping update with courier and
AWB, plus a delivery OTP by SMS. The courier confirms handover against
`POST /internal/delivery/verify`. On a split shipment the second OTP hits the
resend cooldown and is skipped rather than retried — deliberate.

**Retries.** 5 attempts, exponential from 5s (≈10 minutes total), which covers
the gateway restart both specs warn about (`<HTML>…` in the response body).
OTP jobs drop to 3 attempts at a fixed 3s: a code delivered after it expires is
worse than no code.

Retry decisions come from the return-code tables in `providers/errors.js`:

| Kind | Codes | Behaviour |
|---|---|---|
| `retryable` | 91, `<HTML>`, timeouts, empty body | back off and retry |
| `invalid` | 49, 60, 80, 96, 105, 112 | drop immediately, log |
| `credit` | 82, 103 | drop, alert — retrying cannot help |
| `auth` | 72, 86, 98, 99, 102, 104 | drop, alert |

Credit exhaustion and bad credentials stop *all* traffic, so they alert
(debounced hourly) rather than retry. `raiseAlert()` in `dispatcher.js` has a
`TODO` for your webhook — wire it before go-live, and put
`npm run check:credits` on a daily cron. Running out of credits is the most
common way this class of integration fails, and it fails silently.

---

## Things worth knowing about these two APIs

- **Unicode is not optional.** Sura's catalogue is Tamil-facing. Tamil sent as
  `type=0` arrives as junk. `isGsm7()` detects it and switches to `type=2` /
  `txtType=U` with the byte-swapped UTF-16 hex the vendor's C# sample produces.
  Unicode also halves the credit maths: 70 characters per credit, 67 when
  concatenated.
- **Don't double-encode.** The C# samples call `HttpUtility.UrlEncode(message)`
  *and* put it in a form body, which encodes it twice. `URLSearchParams` does it
  once, correctly; pre-encoding would store `%20` literals in the message.
- **`tag` is the WhatsApp duplicate guard.** The spec says it must not repeat.
  We pass the job's idempotency key, so a retry of the same job reuses the same
  tag and the gateway can reject the double.
- **Batch limits differ:** SMS 100 per call (25 recommended, and the spec warns
  you get one message ID per 25); WhatsApp 10.
- **Sender ID is capped at 6 characters** by TRAI, and must be DLT-approved.

## Open questions for SMSIntegra support

Three genuine contradictions in the PDFs. Each is a config var so nothing needs
rewriting once you have answers:

1. **POST field names.** The GET spec and parameter table use `msg` and
   `dtTimeNow`; the POST sample uses `txt` and `dtNow`. Defaults here are `txt`
   / `dtNow` (`SMS_POST_TEXT_FIELD`, `SMS_POST_TIME_FIELD`). Confirm, then send
   one test message and check the delivery report before trusting it.
2. **POST sample references `templateinfo`** in the parameter dictionary, but
   the variable is never declared and the parameter table lists `tempid`
   instead. We send `tempid`.
3. **ChatIntegra base host** appears as both `centralindia01.azurewebsites.net`
   and `centralindia-01.azurewebsites.net`, and the C# samples use a third host
   (`smsintegra.net/whatsapp/waapi.aspx`) that the URL spec doesn't mention.
   `WA_BASE_URL` defaults to the hyphenated Azure host, which is the one used in
   the newer carousel sections.

Also worth asking: whether the SMS account is provisioned for DLR callbacks, so
delivery status can be pushed rather than polled per message ID.

## Testing before go-live

1. `npm run check:credits` — proves credentials and connectivity without sending.
2. One SMS to a team number per template, then `GET /internal/sms/dlr/<id>` to
   confirm it actually reached the handset, not just the gateway.
3. One Tamil message, to confirm the Unicode path end to end.
4. A test order on the duplicate theme → check confirmation SMS + WhatsApp.
5. Replay the same webhook twice from the Shopify admin → confirm exactly one
   message is sent.
6. Registration with a wrong OTP five times → confirm lockout, then a fresh code.
