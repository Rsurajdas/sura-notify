#!/usr/bin/env node
/**
 * Run from cron (e.g. 09:00 daily). Exits non-zero below the threshold so the
 * scheduler itself can alert. Credit exhaustion is the single most common way
 * this integration fails in production, and it fails silently.
 */
import { smsProvider, whatsappProvider } from '../src/providers/index.js';

const THRESHOLD = Number(process.env.CREDIT_ALERT_THRESHOLD ?? 500);
const VALIDITY_DAYS = Number(process.env.VALIDITY_ALERT_DAYS ?? 7);

let failed = false;

for (const [name, provider] of Object.entries({ SMS: smsProvider, WhatsApp: whatsappProvider })) {
  try {
    const { credits, validityDays } = await provider.credits();
    const low = credits < THRESHOLD || validityDays < VALIDITY_DAYS;
    console.log(`${name}: ${credits} credits, ${validityDays} days validity${low ? '  <-- LOW' : ''}`);
    if (low) failed = true;
  } catch (err) {
    console.error(`${name}: check failed — ${err.message}`);
    failed = true;
  }
}

process.exit(failed ? 1 : 0);
