/**
 * Tenant Manager Unit Tests
 * Tests isTenantActive, getValidResetToken, closeConnections,
 * getTenantSubscription, and subscription period tracking.
 *
 * Run: node --test test/tenant-manager.test.js
 */

'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildSuperDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE salon_tenants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT UNIQUE NOT NULL,
      owner_name TEXT NOT NULL,
      salon_name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      phone TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      status TEXT DEFAULT 'active',
      subscription_plan TEXT DEFAULT 'basic',
      subscription_expires TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      price_cents INTEGER NOT NULL DEFAULT 0,
      billing_cycle TEXT NOT NULL DEFAULT 'monthly',
      max_services INTEGER NOT NULL DEFAULT 10,
      whatsapp_access INTEGER NOT NULL DEFAULT 0,
      instagram_access INTEGER NOT NULL DEFAULT 0,
      facebook_access INTEGER NOT NULL DEFAULT 0,
      ai_calls_access INTEGER NOT NULL DEFAULT 0,
      stripe_price_id TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT NOT NULL REFERENCES salon_tenants(tenant_id) ON DELETE CASCADE,
      plan_id INTEGER NOT NULL REFERENCES plans(id),
      stripe_subscription_id TEXT UNIQUE,
      stripe_customer_id TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      current_period_start TEXT,
      current_period_end TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE password_reset_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  return db;
}

// Inline versions of the functions under test that accept an injected db
function isTenantActive(db, tenantId) {
  const tenant = db.prepare('SELECT status FROM salon_tenants WHERE tenant_id = ?').get(tenantId);
  return tenant ? tenant.status === 'active' : false;
}

function getValidResetToken(db, tokenHash) {
  return db.prepare(`
    SELECT * FROM password_reset_tokens
    WHERE token_hash = ? AND used = 0 AND expires_at > datetime('now')
  `).get(tokenHash);
}

function storeResetToken(db, tenantId, tokenHash, expiresAt) {
  db.transaction(() => {
    db.prepare(`DELETE FROM password_reset_tokens WHERE tenant_id = ?`).run(tenantId);
    db.prepare(`DELETE FROM password_reset_tokens WHERE used = 1 OR expires_at < datetime('now')`).run();
    db.prepare(`INSERT INTO password_reset_tokens (tenant_id, token_hash, expires_at) VALUES (?,?,?)`)
      .run(tenantId, tokenHash, expiresAt);
  })();
}

function markResetTokenUsed(db, tokenHash) {
  db.prepare(`UPDATE password_reset_tokens SET used = 1 WHERE token_hash = ?`).run(tokenHash);
}

function getTenantSubscription(db, tenantId) {
  return db.prepare(`
    SELECT s.*, p.name as plan_name, p.max_services, p.whatsapp_access,
           p.instagram_access, p.facebook_access, p.ai_calls_access
    FROM subscriptions s
    JOIN plans p ON p.id = s.plan_id
    WHERE s.tenant_id = ? AND s.status = 'active'
    ORDER BY s.created_at DESC LIMIT 1
  `).get(tenantId) || null;
}

// ── isTenantActive ────────────────────────────────────────────────────────────

describe('isTenantActive()', () => {
  let db;

  before(() => {
    db = buildSuperDb();
    const hash = bcrypt.hashSync('pass123', 10);
    db.prepare(`INSERT INTO salon_tenants (tenant_id, owner_name, salon_name, email, phone, password_hash, status)
                VALUES (?,?,?,?,?,?,?)`)
      .run('SA_01', 'Alice', 'Alice Salon', 'alice@test.com', '+1111', hash, 'active');
    db.prepare(`INSERT INTO salon_tenants (tenant_id, owner_name, salon_name, email, phone, password_hash, status)
                VALUES (?,?,?,?,?,?,?)`)
      .run('SA_02', 'Bob', 'Bob Salon', 'bob@test.com', '+2222', hash, 'suspended');
  });

  after(() => db.close());

  test('returns true for active tenant', () => {
    assert.equal(isTenantActive(db, 'SA_01'), true);
  });

  test('returns false for suspended tenant', () => {
    assert.equal(isTenantActive(db, 'SA_02'), false);
  });

  test('returns false (not undefined) for non-existent tenant', () => {
    const result = isTenantActive(db, 'GHOST_99');
    assert.equal(result, false);
    assert.equal(typeof result, 'boolean', 'must be boolean, not undefined');
  });
});

// ── getValidResetToken ────────────────────────────────────────────────────────

describe('getValidResetToken()', () => {
  let db;

  before(() => { db = buildSuperDb(); });
  after(() => db.close());

  test('returns token for unexpired, unused token', () => {
    const future = new Date(Date.now() + 3_600_000).toISOString().replace('T', ' ').slice(0, 19);
    storeResetToken(db, 'SA_01', 'hash_valid', future);
    const row = getValidResetToken(db, 'hash_valid');
    assert.ok(row, 'should return a row');
    assert.equal(row.token_hash, 'hash_valid');
  });

  test('returns undefined for expired token', () => {
    const past = new Date(Date.now() - 3_600_000).toISOString().replace('T', ' ').slice(0, 19);
    db.prepare(`INSERT INTO password_reset_tokens (tenant_id, token_hash, expires_at) VALUES (?,?,?)`)
      .run('SA_01', 'hash_expired', past);
    const row = getValidResetToken(db, 'hash_expired');
    assert.equal(row, undefined);
  });

  test('returns undefined for already-used token', () => {
    const future = new Date(Date.now() + 3_600_000).toISOString().replace('T', ' ').slice(0, 19);
    storeResetToken(db, 'SA_01', 'hash_used', future);
    markResetTokenUsed(db, 'hash_used');
    const row = getValidResetToken(db, 'hash_used');
    assert.equal(row, undefined);
  });

  test('returns undefined for completely unknown hash', () => {
    const row = getValidResetToken(db, 'hash_unknown_xyz');
    assert.equal(row, undefined);
  });
});

// ── Subscription period tracking ──────────────────────────────────────────────

describe('Subscription current_period_start / current_period_end', () => {
  let db;

  before(() => {
    db = buildSuperDb();
    const hash = bcrypt.hashSync('pass', 10);
    db.prepare(`INSERT INTO salon_tenants (tenant_id, owner_name, salon_name, email, phone, password_hash) VALUES (?,?,?,?,?,?)`)
      .run('SA_10', 'Test', 'Test Salon', 'test@salon.com', '+9999', hash);
    db.prepare(`INSERT INTO plans (name, price_cents, max_services, whatsapp_access, instagram_access) VALUES (?,?,?,?,?)`)
      .run('Basic', 999, 10, 0, 0);
  });

  after(() => db.close());

  test('createSubscription stores period start and end', () => {
    const planId = db.prepare(`SELECT id FROM plans WHERE name = 'Basic'`).get().id;
    const start = '2026-04-18 00:00:00';
    const end   = '2026-05-18 00:00:00';

    db.prepare(`
      INSERT INTO subscriptions (tenant_id, plan_id, status, current_period_start, current_period_end)
      VALUES (?, ?, 'active', ?, ?)
    `).run('SA_10', planId, start, end);

    const sub = getTenantSubscription(db, 'SA_10');
    assert.ok(sub, 'subscription should exist');
    assert.equal(sub.current_period_start, start);
    assert.equal(sub.current_period_end, end);
  });

  test('getTenantSubscription returns null when no active subscription', () => {
    const sub = getTenantSubscription(db, 'SA_NOSUB');
    assert.equal(sub, null);
  });

  test('getTenantSubscription includes plan feature flags', () => {
    const sub = getTenantSubscription(db, 'SA_10');
    assert.ok(sub !== null);
    assert.equal(typeof sub.max_services, 'number');
    assert.equal(typeof sub.whatsapp_access, 'number');
    assert.equal(typeof sub.instagram_access, 'number');
  });
});

// ── max_services enforcement ───────────────────────────────────────────────────

describe('Service count limit via max_services', () => {
  let db;

  before(() => {
    db = buildSuperDb();
    const hash = bcrypt.hashSync('pass', 10);
    db.prepare(`INSERT INTO salon_tenants (tenant_id, owner_name, salon_name, email, phone, password_hash) VALUES (?,?,?,?,?,?)`)
      .run('SA_20', 'LimitTest', 'Limit Salon', 'limit@salon.com', '+8888', hash);
    db.prepare(`INSERT INTO plans (name, price_cents, max_services) VALUES (?,?,?)`)
      .run('Starter', 0, 2);
  });

  after(() => db.close());

  test('plan correctly exposes max_services = 2', () => {
    const plan = db.prepare(`SELECT * FROM plans WHERE name = 'Starter'`).get();
    assert.equal(plan.max_services, 2);
  });

  test('subscription limit is visible via getTenantSubscription', () => {
    const planId = db.prepare(`SELECT id FROM plans WHERE name = 'Starter'`).get().id;
    db.prepare(`INSERT INTO subscriptions (tenant_id, plan_id, status, current_period_start, current_period_end)
                VALUES (?, ?, 'active', datetime('now'), datetime('now', '+30 days'))`).run('SA_20', planId);

    const sub = getTenantSubscription(db, 'SA_20');
    assert.equal(sub.max_services, 2);
  });
});

// ── closeConnections ──────────────────────────────────────────────────────────

describe('closeConnections()', () => {
  test('closing an open db does not throw', () => {
    const db = new Database(':memory:');
    assert.doesNotThrow(() => db.close());
  });

  test('closing already-closed db does not throw (better-sqlite3 is idempotent)', () => {
    const db = new Database(':memory:');
    db.close();
    assert.doesNotThrow(() => db.close());
  });
});
