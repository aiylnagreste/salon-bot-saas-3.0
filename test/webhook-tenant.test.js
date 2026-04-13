/**
 * Webhook Tenant Config Tests
 * Validates per-tenant webhook config storage and token resolution.
 *
 * Run: node --test test/webhook-tenant.test.js
 */

'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

// ── Setup in-memory super.db ──────────────────────────────────────────────────
let db;
before(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenant_webhook_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT NOT NULL UNIQUE,
      wa_phone_number_id TEXT,
      wa_access_token TEXT,
      wa_verify_token TEXT,
      ig_page_access_token TEXT,
      ig_verify_token TEXT,
      fb_page_access_token TEXT,
      fb_verify_token TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);
});

after(() => db.close());

function getWebhookConfig(tenantId) {
  return db.prepare('SELECT * FROM tenant_webhook_configs WHERE tenant_id = ?').get(tenantId) || null;
}

function upsertWebhookConfig(tenantId, config) {
  const { wa_phone_number_id, wa_access_token, wa_verify_token,
          ig_page_access_token, ig_verify_token,
          fb_page_access_token, fb_verify_token } = config;
  db.prepare(`
    INSERT INTO tenant_webhook_configs
      (tenant_id, wa_phone_number_id, wa_access_token, wa_verify_token,
       ig_page_access_token, ig_verify_token,
       fb_page_access_token, fb_verify_token, updated_at)
    VALUES (?,?,?,?,?,?,?,?,datetime('now'))
    ON CONFLICT(tenant_id) DO UPDATE SET
      wa_phone_number_id   = excluded.wa_phone_number_id,
      wa_access_token      = excluded.wa_access_token,
      wa_verify_token      = excluded.wa_verify_token,
      ig_page_access_token = excluded.ig_page_access_token,
      ig_verify_token      = excluded.ig_verify_token,
      fb_page_access_token = excluded.fb_page_access_token,
      fb_verify_token      = excluded.fb_verify_token,
      updated_at           = excluded.updated_at
  `).run(tenantId, wa_phone_number_id, wa_access_token, wa_verify_token,
          ig_page_access_token, ig_verify_token,
          fb_page_access_token, fb_verify_token);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Per-tenant webhook config', () => {
  test('returns null when no config exists', () => {
    const cfg = getWebhookConfig('NONEXISTENT');
    assert.equal(cfg, null);
  });

  test('stores and retrieves config for a tenant', () => {
    upsertWebhookConfig('SA_01', {
      wa_access_token: 'token_sa01',
      wa_verify_token: 'verify_sa01',
      wa_phone_number_id: 'pnid_sa01',
      ig_page_access_token: null,
      ig_verify_token: null,
      fb_page_access_token: null,
      fb_verify_token: null,
    });
    const cfg = getWebhookConfig('SA_01');
    assert.equal(cfg.wa_access_token, 'token_sa01');
    assert.equal(cfg.wa_verify_token, 'verify_sa01');
  });

  test('tenant SA_02 config is isolated from SA_01', () => {
    upsertWebhookConfig('SA_02', {
      wa_access_token: 'token_sa02',
      wa_verify_token: 'verify_sa02',
      wa_phone_number_id: 'pnid_sa02',
      ig_page_access_token: null,
      ig_verify_token: null,
      fb_page_access_token: null,
      fb_verify_token: null,
    });
    const cfg1 = getWebhookConfig('SA_01');
    const cfg2 = getWebhookConfig('SA_02');
    assert.notEqual(cfg1.wa_access_token, cfg2.wa_access_token);
    assert.equal(cfg1.wa_access_token, 'token_sa01');
    assert.equal(cfg2.wa_access_token, 'token_sa02');
  });

  test('upsert overwrites existing config', () => {
    upsertWebhookConfig('SA_01', {
      wa_access_token: 'token_sa01_updated',
      wa_verify_token: 'verify_sa01',
      wa_phone_number_id: 'pnid_sa01',
      ig_page_access_token: null,
      ig_verify_token: null,
      fb_page_access_token: null,
      fb_verify_token: null,
    });
    const cfg = getWebhookConfig('SA_01');
    assert.equal(cfg.wa_access_token, 'token_sa01_updated');
  });

  test('token resolution: per-tenant token takes priority over env fallback', () => {
    const config = getWebhookConfig('SA_01');
    const envFallback = 'env_global_token';
    const resolved = config?.wa_access_token || envFallback;
    assert.equal(resolved, 'token_sa01_updated');
  });

  test('token resolution: falls back to env when no per-tenant token', () => {
    const config = getWebhookConfig('NONEXISTENT');
    const envFallback = 'env_global_token';
    const resolved = config?.wa_access_token || envFallback;
    assert.equal(resolved, envFallback);
  });
});
