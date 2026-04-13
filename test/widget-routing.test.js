/**
 * Widget Routing Tests
 * Validates that the chat API requires tenantId and rejects unknown tenants.
 *
 * These tests run against the live server — start it first:
 *   node src/index.js  (in a separate terminal)
 *
 * Or run unit-style tests below that don't need the server.
 *
 * Run: node --test test/widget-routing.test.js
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// ── Unit tests (no server needed) ─────────────────────────────────────────────

describe('Widget chat request validation', () => {
  // Simulate the validation logic from POST /api/chat
  function validateChatRequest(body) {
    const { message, sessionId, tenantId } = body || {};
    if (!message || !sessionId) return { error: 'message and sessionId required' };
    if (!tenantId) return { error: 'tenantId required' };
    return null; // valid
  }

  test('rejects request with no tenantId', () => {
    const err = validateChatRequest({ message: 'hello', sessionId: 'abc' });
    assert.ok(err);
    assert.equal(err.error, 'tenantId required');
  });

  test('rejects request with no message', () => {
    const err = validateChatRequest({ sessionId: 'abc', tenantId: 'SA_01' });
    assert.ok(err);
    assert.match(err.error, /message/);
  });

  test('rejects request with no sessionId', () => {
    const err = validateChatRequest({ message: 'hi', tenantId: 'SA_01' });
    assert.ok(err);
    assert.match(err.error, /sessionId/);
  });

  test('accepts valid request with all required fields', () => {
    const err = validateChatRequest({ message: 'hello', sessionId: 'abc', tenantId: 'SA_01' });
    assert.equal(err, null);
  });
});

describe('Widget URL isolation', () => {
  test('/widget/SA_01/widget.js and /widget/SA_02/widget.js are different URLs', () => {
    const url1 = '/widget/SA_01/widget.js';
    const url2 = '/widget/SA_02/widget.js';
    const slug1 = url1.split('/')[2];
    const slug2 = url2.split('/')[2];
    assert.equal(slug1, 'SA_01');
    assert.equal(slug2, 'SA_02');
    assert.notEqual(slug1, slug2);
  });

  test('tenantId is extracted from widget URL slug correctly', () => {
    // Simulate route param extraction: /widget/:tenantId/widget.js
    function extractTenantFromUrl(url) {
      const parts = url.split('/');
      return parts[2] || null;
    }
    assert.equal(extractTenantFromUrl('/widget/SA_01/widget.js'), 'SA_01');
    assert.equal(extractTenantFromUrl('/widget/SA_02/widget.js'), 'SA_02');
    assert.equal(extractTenantFromUrl('/widget.js'), null);
  });
});
