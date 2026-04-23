// salon-bot/src/utils/phone.js
// Shared E.164-compatible phone validator.
// Strips whitespace / dashes / parens / dots / tabs.
// Accepts an optional single leading '+'.
// Requires 8–15 digits after stripping.

const STRIP_RE = /[\s\-().\t]/g;

function normalizePhone(input) {
  if (input == null) return null;
  const str = String(input).trim();
  if (!str) return null;
  const stripped = str.replace(STRIP_RE, '');
  // Optional single leading '+', then only digits
  const m = stripped.match(/^(\+?)([0-9]+)$/);
  if (!m) return null;
  const plus = m[1];
  const digits = m[2];
  if (digits.length < 8 || digits.length > 15) return null;
  return `${plus}${digits}`;
}

function isValidPhone(input) {
  return normalizePhone(input) !== null;
}

module.exports = { normalizePhone, isValidPhone };
