import express from 'express';
import { env } from '../config/env.js';
import { logger, maskPhone } from '../lib/logger.js';

/**
 * ChatIntegra posts inbound WhatsApp messages here (the "WhatsApp Incoming
 * messages" page of the spec). Nothing consumes these yet — they are logged so
 * the two-way flows the client asked about later (order status replies, quick
 * reply buttons) have a place to land.
 *
 * The spec defines no signature on these callbacks, so the URL carries a shared
 * secret: https://…/inbound/whatsapp?key=<WA_INBOUND_SECRET>
 */
export const inboundRouter = express.Router();

inboundRouter.use(express.urlencoded({ extended: true, limit: '1mb' }));
inboundRouter.use(express.json({ limit: '1mb' }));

inboundRouter.post('/whatsapp', (req, res) => {
  if (env.WA_INBOUND_SECRET && req.query.key !== env.WA_INBOUND_SECRET) {
    return res.status(401).send('unauthorised');
  }

  const body = req.body ?? {};
  logger.info(
    {
      from: maskPhone(body.from),
      contentType: body.content_type,
      buttonId: body.ButtonReplyID ?? null,
      listId: body.LIST_REPLY_ROW_IDENTIFIER ?? null,
      timestamp: body.timestamp,
    },
    'inbound whatsapp message',
  );

  // TODO: route replies — e.g. ButtonReplyID "TRACK" -> send tracking status.
  res.status(200).send('ok');
});
