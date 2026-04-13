/**
 * salonDataCache.js
 * 
 * Multi-tenant persistent JSON cache - ONLY for services and deals
 * All other data (bookings, staff, branches, etc.) reads directly from DB
 */

'use strict';

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const CACHE_DIR = path.join(__dirname, '../../data');

// ── Multi-tenant storage ────────────────────────────────────────────────────────
let _tenantCaches = new Map(); // tenantId -> cache object (only services & deals)
let _writeQueues = new Map();   // tenantId -> promise chain

// ── Helpers ───────────────────────────────────────────────────────────────────

function _buildEmpty(tenantId = null) {
  const now = new Date().toISOString();
  return {
    meta: {
      version: 1,
      generatedAt: now,
      updatedAt: now,
      tenantId: tenantId
    },
    deals: [],
    services: [],
    // NO other cached data
  };
}

function _getCacheFile(tenantId) {
  return path.join(CACHE_DIR, `${tenantId}-salon-data.json`);
}

function _getCacheTmp(tenantId) {
  return path.join(CACHE_DIR, `${tenantId}-salon-data.json.tmp`);
}

/**
 * Full rebuild from DB for a specific tenant - ONLY services and deals
 */
async function _buildFromDb(tenantId) {
  const { getDb } = require('../db/database');
  const db = getDb();
  const cache = _buildEmpty(tenantId);

  try {
    // Only fetch services and deals - nothing else
    try {
      cache.deals = db.prepare(`SELECT * FROM ${tenantId}_deals ORDER BY id`).all() || [];
    } catch (e) {
      logger.warn(`[cache] Could not load deals for ${tenantId}:`, e.message);
      cache.deals = [];
    }

    try {
      cache.services = db.prepare(`SELECT * FROM ${tenantId}_services ORDER BY branch, name`).all() || [];
    } catch (e) {
      logger.warn(`[cache] Could not load services for ${tenantId}:`, e.message);
      cache.services = [];
    }

    const now = new Date().toISOString();
    cache.meta.generatedAt = now;
    cache.meta.updatedAt = now;

    logger.info(`[cache] Built cache for tenant ${tenantId} from DB (${cache.services.length} services, ${cache.deals.length} deals)`);
  } catch (err) {
    logger.error(`[cache] _buildFromDb failed for ${tenantId}:`, err.message);
  }

  return cache;
}

/**
 * Load cache from disk for a specific tenant
 */
async function _loadFromDisk(tenantId) {
  const cacheFile = _getCacheFile(tenantId);

  if (!fs.existsSync(cacheFile)) {
    logger.info(`[cache] No cache file found for tenant ${tenantId}, will build from DB`);
    return null;
  }

  try {
    const raw = fs.readFileSync(cacheFile, 'utf8');
    const cache = JSON.parse(raw);

    // Verify this cache belongs to the correct tenant
    if (cache.meta && cache.meta.tenantId !== tenantId) {
      logger.warn(`[cache] Cache tenant mismatch: ${cache.meta.tenantId} vs ${tenantId}`);
      return null;
    }

    logger.info(`[cache] Loaded cache for tenant ${tenantId} from disk`);
    return cache;
  } catch (parseErr) {
    logger.error(`[cache] Cache file corrupt for tenant ${tenantId}:`, parseErr.message);
    return null;
  }
}

/**
 * Persist a tenant's cache to disk atomically
 */
async function saveAtomic(tenantId) {
  if (!_writeQueues.has(tenantId)) {
    _writeQueues.set(tenantId, Promise.resolve());
  }

  const queue = _writeQueues.get(tenantId);
  const cache = _tenantCaches.get(tenantId);

  if (!cache) {
    logger.warn(`[cache] saveAtomic called for tenant ${tenantId} but no cache found`);
    return queue;
  }

  const newQueue = queue.then(async () => {
    try {
      // Ensure cache directory exists
      if (!fs.existsSync(CACHE_DIR)) {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
      }

      cache.meta.updatedAt = new Date().toISOString();
      const json = JSON.stringify(cache, null, 2);
      const tmpFile = _getCacheTmp(tenantId);
      const cacheFile = _getCacheFile(tenantId);

      fs.writeFileSync(tmpFile, json, 'utf8');
      fs.renameSync(tmpFile, cacheFile);
    } catch (err) {
      logger.error(`[cache] Atomic write failed for tenant ${tenantId}:`, err.message);
    }
  });

  _writeQueues.set(tenantId, newQueue);
  return newQueue;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Initialise cache for a specific tenant on server start
 * @param {string} tenantId - The tenant ID (e.g., 'SA_01')
 */
async function initCache(tenantId) {
  if (!tenantId) {
    logger.warn('[cache] initCache called without tenantId');
    return;
  }

  try {
    // Try to load from disk first
    let cache = await _loadFromDisk(tenantId);

    if (!cache) {
      // Build from database if disk cache doesn't exist or is invalid
      cache = await _buildFromDb(tenantId);
    }

    _tenantCaches.set(tenantId, cache);
    await saveAtomic(tenantId);

    logger.info(`[cache] Cache initialized for tenant ${tenantId} (services & deals only)`);
  } catch (err) {
    logger.error(`[cache] initCache failed for tenant ${tenantId}:`, err.message);
    // Create empty cache as fallback
    _tenantCaches.set(tenantId, _buildEmpty(tenantId));
  }
}

/**
 * Get cache for a specific tenant - ONLY returns services and deals
 * @param {string} tenantId - The tenant ID
 * @returns {object|null} Cache object or null if not found
 */
function getCache(tenantId) {
  if (!tenantId) {
    logger.warn('[cache] getCache called without tenantId');
    return null;
  }

  const cache = _tenantCaches.get(tenantId);
  if (!cache) {
    logger.warn(`[cache] No cache found for tenant ${tenantId}, call initCache first`);
    return null;
  }

  // Return only services and deals - force other data to be read from DB
  return {
    services: cache.services,
    deals: cache.deals
  };
}

/**
 * Get all tenant IDs that have caches loaded
 */
function getActiveTenants() {
  return Array.from(_tenantCaches.keys());
}

/**
 * Apply an incremental CRUD patch to a tenant's cache - ONLY for services/deals
 *
 * @param {string} tenantId - The tenant ID
 * @param {string} entityType - 'deals' | 'services' (only these are cached)
 * @param {'upsert'|'delete'|'replace'} op
 * @param {object|Array} payload
 */
async function patchCache(tenantId, entityType, op, payload) {
  if (!tenantId) {
    logger.warn('[cache] patchCache called without tenantId');
    return;
  }

  // Only cache services and deals - ignore all other entity types
  if (entityType !== 'deals' && entityType !== 'services') {
    // logger.debug(`[cache] Skipping cache for ${entityType} (not cached)`);
    return;
  }

  const cache = _tenantCaches.get(tenantId);
  if (!cache) {
    logger.warn(`[cache] patchCache called for tenant ${tenantId} but cache not initialized`);
    return;
  }

  try {
    if (op === 'replace') {
      // Replace entire entity array
      cache[entityType] = payload;

    } else if (op === 'upsert') {
      const arr = cache[entityType];
      if (!Array.isArray(arr)) return;

      const pid = payload.id ? Number(payload.id) : null;
      if (pid) {
        const idx = arr.findIndex(item => Number(item.id) === pid);
        if (idx >= 0) {
          arr[idx] = payload;
        } else {
          arr.push(payload);
        }
      } else {
        arr.push(payload);
      }

    } else if (op === 'delete') {
      const arr = cache[entityType];
      if (!Array.isArray(arr)) return;

      const pid = Number(payload.id);
      const idx = arr.findIndex(item => Number(item.id) === pid);
      if (idx >= 0) arr.splice(idx, 1);
    }

    // Save to disk after update
    await saveAtomic(tenantId);

  } catch (err) {
    logger.error(`[cache] patchCache error for tenant ${tenantId} (${entityType}/${op}):`, err.message);
  }
}

/**
 * Refresh cache for a tenant from database (force rebuild)
 */
async function refreshCache(tenantId) {
  if (!tenantId) {
    logger.warn('[cache] refreshCache called without tenantId');
    return;
  }

  logger.info(`[cache] Refreshing cache for tenant ${tenantId} from DB`);
  const newCache = await _buildFromDb(tenantId);
  _tenantCaches.set(tenantId, newCache);
  await saveAtomic(tenantId);
}

/**
 * Clear cache for a specific tenant (free memory)
 */
async function clearCache(tenantId) {
  if (!tenantId) return;

  if (_tenantCaches.has(tenantId)) {
    _tenantCaches.delete(tenantId);
    logger.info(`[cache] Cleared cache for tenant ${tenantId}`);
  }
}

/**
 * Clear all caches
 */
async function clearAllCaches() {
  _tenantCaches.clear();
  _writeQueues.clear();
  logger.info('[cache] Cleared all tenant caches');
}

module.exports = {
  initCache,
  getCache,
  patchCache,
  saveAtomic,
  refreshCache,
  clearCache,
  clearAllCaches,
  getActiveTenants
};