// src/utils/metaCredentialTester.js
// Live Meta Graph API credential testers used on webhook-config save.
// Each function returns { ok: boolean, error?: string } and never throws.

const axios = require('axios');
const logger = require('./logger');

const GRAPH_BASE = 'https://graph.facebook.com/v21.0';
const TIMEOUT_MS = 5000;

function formatAxiosError(err) {
    if (err.code === 'ECONNABORTED') return 'timeout';
    const metaMsg = err.response && err.response.data && err.response.data.error && err.response.data.error.message;
    if (metaMsg) return metaMsg;
    return err.message || 'unknown error';
}

async function testWhatsAppCredentials({ phone_number_id, access_token } = {}) {
    if (!phone_number_id || !access_token) {
        return { ok: false, error: 'missing credentials' };
    }
    try {
        const res = await axios.get(
            `${GRAPH_BASE}/${encodeURIComponent(phone_number_id)}`,
            { params: { access_token }, timeout: TIMEOUT_MS }
        );
        return { ok: res.status === 200 };
    } catch (err) {
        const msg = formatAxiosError(err);
        logger.warn(`[metaCredentialTester] WA test failed: ${msg}`);
        return { ok: false, error: msg };
    }
}

async function testInstagramCredentials({ page_access_token } = {}) {
    if (!page_access_token) {
        return { ok: false, error: 'missing credentials' };
    }
    try {
        const res = await axios.get(
            `${GRAPH_BASE}/me`,
            { params: { access_token: page_access_token, fields: 'id' }, timeout: TIMEOUT_MS }
        );
        return { ok: res.status === 200 };
    } catch (err) {
        const msg = formatAxiosError(err);
        logger.warn(`[metaCredentialTester] IG test failed: ${msg}`);
        return { ok: false, error: msg };
    }
}

async function testFacebookCredentials({ page_access_token } = {}) {
    if (!page_access_token) {
        return { ok: false, error: 'missing credentials' };
    }
    try {
        const res = await axios.get(
            `${GRAPH_BASE}/me`,
            { params: { access_token: page_access_token, fields: 'id' }, timeout: TIMEOUT_MS }
        );
        return { ok: res.status === 200 };
    } catch (err) {
        const msg = formatAxiosError(err);
        logger.warn(`[metaCredentialTester] FB test failed: ${msg}`);
        return { ok: false, error: msg };
    }
}

module.exports = {
    testWhatsAppCredentials,
    testInstagramCredentials,
    testFacebookCredentials,
};
