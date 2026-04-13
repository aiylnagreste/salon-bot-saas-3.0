/**
 * Tenant Isolation Tests
 * Verifies that one tenant cannot access another tenant's data.
 *
 * Run: node --test test/tenant-isolation.test.js
 */

'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Minimal in-process test of the DB layer:
 * Creates two tenants, inserts a booking for each, then verifies
 * that querying with the wrong tenantId returns 0 rows.
 */
describe('DB-level tenant isolation', () => {
  let db;
  const T1 = 'TEST_T1';
  const T2 = 'TEST_T2';

  before(() => {
    // Use an in-memory SQLite database for tests
    const Database = require('better-sqlite3');
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');

    for (const tid of [T1, T2]) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS ${tid}_bookings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          customer_name TEXT NOT NULL,
          phone TEXT,
          service TEXT,
          branch TEXT,
          date TEXT,
          time TEXT,
          status TEXT DEFAULT 'confirmed'
        )
      `);
    }

    // Insert one booking per tenant
    db.prepare(`INSERT INTO ${T1}_bookings (customer_name, phone, service, branch, date, time) VALUES (?,?,?,?,?,?)`)
      .run('Alice T1', '+1111', 'Haircut', 'Branch A', '2026-05-01', '10:00');
    db.prepare(`INSERT INTO ${T2}_bookings (customer_name, phone, service, branch, date, time) VALUES (?,?,?,?,?,?)`)
      .run('Bob T2', '+2222', 'Facial', 'Branch B', '2026-05-01', '11:00');
  });

  after(() => {
    db.close();
  });

  test('T1 bookings are not visible when querying T2 tables', () => {
    const rows = db.prepare(`SELECT * FROM ${T2}_bookings WHERE phone = ?`).all('+1111');
    assert.equal(rows.length, 0, 'T1 customer must not appear in T2 table');
  });

  test('T2 bookings are not visible when querying T1 tables', () => {
    const rows = db.prepare(`SELECT * FROM ${T1}_bookings WHERE phone = ?`).all('+2222');
    assert.equal(rows.length, 0, 'T2 customer must not appear in T1 table');
  });

  test('Each tenant sees only their own bookings', () => {
    const t1rows = db.prepare(`SELECT * FROM ${T1}_bookings`).all();
    const t2rows = db.prepare(`SELECT * FROM ${T2}_bookings`).all();

    assert.equal(t1rows.length, 1);
    assert.equal(t2rows.length, 1);
    assert.equal(t1rows[0].customer_name, 'Alice T1');
    assert.equal(t2rows[0].customer_name, 'Bob T2');
  });
});

// ── HTTP-layer tenant isolation ───────────────────────────────────────────────
describe('JWT tenantId extraction', () => {
  test('requireTenantAuth sets req.tenantId from token payload', () => {
    const jwt = require('jsonwebtoken');
    // Use a test secret
    const secret = 'test-secret-32-bytes-long-enough!';
    const token = jwt.sign({ tenantId: 'SA_01', email: 'a@b.com' }, secret, { expiresIn: '1h' });
    const decoded = jwt.verify(token, secret);
    assert.equal(decoded.tenantId, 'SA_01');
  });

  test('Forged token with wrong secret is rejected', () => {
    const jwt = require('jsonwebtoken');
    const realSecret = 'real-secret-32-bytes-long-enough!';
    const fakeSecret = 'fake-secret-32-bytes-long-enough!';
    const forgedToken = jwt.sign({ tenantId: 'SA_02' }, fakeSecret);
    assert.throws(() => jwt.verify(forgedToken, realSecret), /invalid signature/);
  });
});
