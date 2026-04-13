const { routeMessage } = require('../core/router');
const { send } = require('../utils/metaSender');
const { markWebhookVerified } = require('../db/tenantManager');
const logger = require('../utils/logger');

async function handleInstagram(req, res, tenantId, webhookConfig) {
  res.sendStatus(200);

  try {
    const body = req.body;
    if (!body.object || body.object !== 'instagram') return;

    const entry = body.entry?.[0];
    const messaging = entry?.messaging?.[0];

    if (!messaging?.message?.text) return;
    if (messaging.message.is_echo) return;

    const userId = messaging.sender.id;
    const text = messaging.message.text;

    logger.info(`[Instagram] tenant:${tenantId || 'legacy'} from:${userId} | ${text}`);

    if (!tenantId) {
      logger.warn('[Instagram] No tenantId — message dropped. Use per-tenant webhook URL.');
      return;
    }

    const reply = await routeMessage(userId, text, 'instagram', tenantId);
    const igToken = webhookConfig?.ig_page_access_token || process.env.IG_PAGE_ACCESS_TOKEN;
    await send('instagram', userId, reply, { token: igToken });
  } catch (err) {
    logger.error('[Instagram] Handler error:', err.message);
  }
}

function verifyInstagram(req, res, webhookConfig, tenantId) {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  const expected = webhookConfig?.ig_verify_token || process.env.META_VERIFY_TOKEN;

  if (mode === 'subscribe' && token === expected) {
    logger.info('[Instagram] Webhook verified');
    if (tenantId) markWebhookVerified(tenantId, 'instagram');
    res.status(200).send(challenge);
  } else {
    logger.error('[Instagram] Webhook verification failed');
    res.sendStatus(403);
  }
}

module.exports = { handleInstagram, verifyInstagram };
