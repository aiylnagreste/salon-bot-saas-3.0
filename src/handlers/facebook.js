const { routeMessage } = require('../core/router');
const { send } = require('../utils/metaSender');
const { markWebhookVerified } = require('../db/tenantManager');
const logger = require('../utils/logger');

async function handleFacebook(req, res, tenantId, webhookConfig) {
  res.sendStatus(200);

  try {
    const body = req.body;
    if (!body.object || body.object !== 'page') return;

    const entry = body.entry?.[0];
    const messaging = entry?.messaging?.[0];

    if (!messaging?.message?.text) return;
    if (messaging.message.is_echo) return;

    const userId = messaging.sender.id;
    const text = messaging.message.text;

    logger.info(`[Facebook] tenant:${tenantId || 'legacy'} from:${userId} | ${text}`);

    if (!tenantId) {
      logger.warn('[Facebook] No tenantId — message dropped. Use per-tenant webhook URL.');
      return;
    }

    const reply = await routeMessage(userId, text, 'facebook', tenantId);
    const fbToken = webhookConfig?.fb_page_access_token || process.env.FB_PAGE_ACCESS_TOKEN;
    await send('facebook', userId, reply, { token: fbToken });
  } catch (err) {
    logger.error('[Facebook] Handler error:', err.message);
  }
}

function verifyFacebook(req, res, webhookConfig, tenantId) {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  const expected = webhookConfig?.fb_verify_token || process.env.META_VERIFY_TOKEN;

  if (mode === 'subscribe' && token === expected) {
    logger.info('[Facebook] Webhook verified');
    if (tenantId) markWebhookVerified(tenantId, 'facebook');
    res.status(200).send(challenge);
  } else {
    logger.error('[Facebook] Webhook verification failed');
    res.sendStatus(403);
  }
}

module.exports = { handleFacebook, verifyFacebook };
