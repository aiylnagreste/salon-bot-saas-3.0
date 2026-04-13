/**
 * Booking Lifecycle Tests
 * Validates status transition rules and soft-delete behaviour.
 *
 * Run: node --test test/booking-lifecycle.test.js
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// ── Import the transition logic directly ──────────────────────────────────────
// Extract the relevant logic inline so we don't have to boot the full server.

const STATUS_TRANSITIONS = {
  confirmed:  ['canceled', 'completed', 'no_show'],
  no_show:    ['confirmed'],
  canceled:   [],
  completed:  [],
};

function validateStatusTransition(currentStatus, newStatus) {
  const curr = (currentStatus || 'confirmed').toLowerCase();
  const next = (newStatus || '').toLowerCase();
  if (curr === next) return null;
  const allowed = STATUS_TRANSITIONS[curr] || [];
  if (!allowed.includes(next))
    return `Cannot change status from '${curr}' to '${next}'.`;
  return null;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Status transition matrix', () => {
  test('confirmed → canceled is allowed', () => {
    assert.equal(validateStatusTransition('confirmed', 'canceled'), null);
  });

  test('confirmed → completed is allowed', () => {
    assert.equal(validateStatusTransition('confirmed', 'completed'), null);
  });

  test('confirmed → no_show is allowed', () => {
    assert.equal(validateStatusTransition('confirmed', 'no_show'), null);
  });

  test('no_show → confirmed is allowed (undo false no-show)', () => {
    assert.equal(validateStatusTransition('no_show', 'confirmed'), null);
  });

  test('canceled → anything is blocked (terminal)', () => {
    assert.match(validateStatusTransition('canceled', 'confirmed'), /Cannot/);
    assert.match(validateStatusTransition('canceled', 'completed'), /Cannot/);
  });

  test('completed → anything is blocked (terminal)', () => {
    assert.match(validateStatusTransition('completed', 'confirmed'), /Cannot/);
    assert.match(validateStatusTransition('completed', 'canceled'), /Cannot/);
  });

  test('same status returns null (no-op)', () => {
    assert.equal(validateStatusTransition('confirmed', 'confirmed'), null);
    assert.equal(validateStatusTransition('canceled', 'canceled'), null);
  });
});

describe('Soft-delete (archive) semantics', () => {
  test('archived bookings are NOT shown in normal listing', () => {
    const bookings = [
      { id: 1, status: 'confirmed',  customer_name: 'Alice' },
      { id: 2, status: 'archived',   customer_name: 'Bob' },
      { id: 3, status: 'completed',  customer_name: 'Charlie' },
    ];

    // Simulate the SQL filter: status != 'archived'
    const visible = bookings.filter(b => b.status !== 'archived');
    assert.equal(visible.length, 2);
    assert.ok(!visible.find(b => b.customer_name === 'Bob'));
  });
});
