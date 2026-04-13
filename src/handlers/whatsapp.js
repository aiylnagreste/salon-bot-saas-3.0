const { routeMessage } = require('../core/router');
const { send } = require('../utils/metaSender');
const { markWebhookVerified } = require('../db/tenantManager');
const logger = require('../utils/logger');

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {string} tenantId  — resolved from route param (per-tenant) or undefined (legacy)
 * @param {object} webhookConfig — per-tenant config row (or null → falls back to .env globals)
 */
async function handleWhatsApp(req, res, tenantId, webhookConfig) {
  // Acknowledge immediately — Meta requires 200 within 5 seconds
  res.sendStatus(200);

  try {
    const body = req.body;
    if (!body.object || body.object !== 'whatsapp_business_account') return;

    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    // Ignore status updates (delivered, read, etc.)
    if (!value?.messages) return;

    const message = value.messages[0];
    if (message.type !== 'text') return;

    const userId = message.from;
    const text = message.text.body;
    const phoneNumberId = value.metadata.phone_number_id;

    logger.info(`[WhatsApp] tenant:${tenantId || 'legacy'} from:${userId} | ${text}`);

    if (!tenantId) {
      logger.warn('[WhatsApp] No tenantId — message dropped. Use per-tenant webhook URL.');
      return;
    }

    const reply = await routeMessage(userId, text, 'whatsapp', tenantId);

    // Use per-tenant token if available, else fall back to .env global
    const waToken = webhookConfig?.wa_access_token || process.env.WA_ACCESS_TOKEN;
    const waPnId  = webhookConfig?.wa_phone_number_id || phoneNumberId || process.env.WA_PHONE_NUMBER_ID;

    await send('whatsapp', userId, reply, { phoneNumberId: waPnId, token: waToken });
  } catch (err) {
    logger.error('[WhatsApp] Handler error:', err.message);
  }
}

/**
 * Webhook verification — works for both per-tenant and legacy routes
 */
function verifyWhatsApp(req, res, webhookConfig, tenantId) {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  const expected = webhookConfig?.wa_verify_token || process.env.META_VERIFY_TOKEN;

  if (mode === 'subscribe' && token === expected) {
    logger.info('[WhatsApp] Webhook verified');
    if (tenantId) markWebhookVerified(tenantId, 'whatsapp');
    res.status(200).send(challenge);
  } else {
    logger.error('[WhatsApp] Webhook verification failed');
    res.sendStatus(403);
  }
}

module.exports = { handleWhatsApp, verifyWhatsApp };
