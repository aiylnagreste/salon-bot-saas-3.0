// middleware/planGate.js
// Reusable plan-feature gate — reads live plan flags from super.db on every request (SEC-03).

const { getSuperDb } = require('../db/tenantManager');
const logger = require('../utils/logger');

// featureKey → plans.<column_name>
const FEATURE_COLUMN_MAP = {
  whatsapp:  'whatsapp_access',
  instagram: 'instagram_access',
  facebook:  'facebook_access',
  widget:    'widget_access',
  ai_calls:  'ai_calls_access',
};

/**
 * Factory that returns Express middleware gating the request behind a plan feature flag.
 * Must be chained AFTER requireTenantAuth (relies on req.tenantId).
 *
 * @param {'whatsapp'|'instagram'|'facebook'|'widget'|'ai_calls'} featureKey
 * @returns {(req, res, next) => void}
 */
function requirePlanFeature(featureKey) {
  const column = FEATURE_COLUMN_MAP[featureKey];
  if (!column) {
    throw new Error(`[planGate] Unknown featureKey: ${featureKey}`);
  }

  return (req, res, next) => {
    const tenantId = req.tenantId;
    if (!tenantId) {
      logger.error('[planGate] req.tenantId missing — must be chained after requireTenantAuth');
      return res.status(500).json({ ok: false, error: 'Server misconfiguration' });
    }

    try {
      const db = getSuperDb();
      const row = db.prepare(`
        SELECT p.${column} AS has_feature
        FROM subscriptions s
        JOIN plans p ON p.id = s.plan_id
        WHERE s.tenant_id = ? AND s.status = 'active'
        ORDER BY s.created_at DESC LIMIT 1
      `).get(tenantId);

      // No active subscription OR feature flag is 0 → block
      if (!row || row.has_feature !== 1) {
        logger.warn(`[planGate] Blocked ${tenantId} on feature '${featureKey}' (row=${JSON.stringify(row)})`);
        return res.status(403).json({ ok: false, error: 'Feature not available on your plan' });
      }

      next();
    } catch (err) {
      logger.error(`[planGate] Error checking feature ${featureKey}:`, err.message);
      return res.status(500).json({ ok: false, error: 'Plan check failed' });
    }
  };
}

module.exports = { requirePlanFeature, FEATURE_COLUMN_MAP };
