const axios = require('axios');
const logger = require('./logger');

const GRAPH_API_VERSION = 'v19.0';
const BASE_URL = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

/**
 * Unified send function for all three platforms.
 * @param {'whatsapp'|'instagram'|'facebook'} platform
 * @param {string} recipientId
 * @param {string} text
 * @param {object} [opts]
 *   opts.phoneNumberId — WhatsApp phone-number ID (per-tenant or from .env)
 *   opts.token         — access token (per-tenant); falls back to process.env per-platform
 */
async function send(platform, recipientId, text, opts = {}) {
  try {
    switch (platform) {
      case 'whatsapp': {
        const token = opts.token || process.env.WA_ACCESS_TOKEN;
        const phoneNumberId = opts.phoneNumberId || process.env.WA_PHONE_NUMBER_ID;
        await sendWhatsApp(recipientId, text, phoneNumberId, token);
        break;
      }
      case 'instagram': {
        const token = opts.token || process.env.IG_PAGE_ACCESS_TOKEN;
        await sendInstagramOrFacebook(recipientId, text, token);
        break;
      }
      case 'facebook': {
        const token = opts.token || process.env.FB_PAGE_ACCESS_TOKEN;
        await sendInstagramOrFacebook(recipientId, text, token);
        break;
      }
      default:
        logger.error(`[metaSender] Unknown platform: ${platform}`);
    }
  } catch (err) {
    logger.error(`[metaSender] Send failed on ${platform}:`, err.response?.data || err.message);
  }
}

async function sendWhatsApp(to, text, phoneNumberId, token) {
  const url = `${BASE_URL}/${phoneNumberId}/messages`;
  await axios.post(
    url,
    {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text },
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    }
  );
  logger.info(`[WhatsApp] Sent to ${to}`);
}

async function sendInstagramOrFacebook(recipientId, text, accessToken) {
  const url = `${BASE_URL}/me/messages`;
  await axios.post(
    url,
    {
      recipient: { id: recipientId },
      message: { text },
    },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    }
  );
  logger.info(`[metaSender] Sent to ${recipientId}`);
}

module.exports = { send };
