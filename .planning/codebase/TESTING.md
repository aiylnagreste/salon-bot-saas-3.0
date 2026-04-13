# Testing Patterns

**Analysis Date:** 2026-04-02

## Test Framework

**Runner:** None configured.
- No Jest, Vitest, Mocha, or any other test runner installed
- No test scripts in `package.json` (`scripts` contains only `start`, `dev`, `seed`)
- Zero `.test.js` or `.spec.js` files anywhere in the repository
- No `__tests__/` directory

**Assertion Library:** None.

**Run Commands:**
```bash
npm start         # Run application (src/index.js)
npm run dev       # Run with nodemon — auto-reload on file changes
npm run seed      # Trigger seed via node src/db/seed.js
```

There is no `npm test` command.

**Status:** Zero test coverage. No testing infrastructure has been set up at any layer.

## Current Coverage: Zero

Every module in the project is untested. The list below covers all testable units:

| File | Testable Units | Automated Tests |
|------|----------------|-----------------|
| `src/core/intent.js` | `detectIntent()` | None |
| `src/core/router.js` | `routeMessage()` | None |
| `src/core/session.js` | `getSession`, `setSession`, `clearSession`, `isSessionExpired` | None |
| `src/replies/booking.js` | `handleBookingStep`, `isValidName`, `isValidPhone`, `isValidDate`, `isValidTime`, `extractName`, `extractPhone`, `extractDate`, `extractTime`, `parseTimeTo24h`, `normalizeDateToISO`, `getSalonTiming` | None |
| `src/replies/prices.js` | `getPricesReply`, `getServiceDetail`, `getServiceListReply` | None |
| `src/replies/deals.js` | `getDealsReply` | None |
| `src/replies/branches.js` | `getBranchesReply`, `getBranches` | None |
| `src/index.js` | `validateBookingBody`, `checkStaffBranch`, `checkBookingTiming`, all route handlers | None |
| `src/db/database.js` | `getDb`, `initSchema`, `getSettings`, `invalidateSettingsCache` | None |
| `src/cache/salonDataCache.js` | `initCache`, `getCache`, `patchCache`, `saveAtomic` | None |
| `src/handlers/whatsapp.js` | `handleWhatsApp`, `verifyWhatsApp` | None |
| `src/handlers/instagram.js` | `handleInstagram`, `verifyInstagram` | None |
| `src/handlers/facebook.js` | `handleFacebook`, `verifyFacebook` | None |
| `src/utils/metaSender.js` | `send`, `sendWhatsApp`, `sendInstagramOrFacebook` | None |
| `src/server/apiCallLive.js` | `handleVoiceTool`, `setupCallServer` | None |
| `src/admin/auth.js` | `requireAdminAuth` | None |

## How the System is Currently Verified

All verification is manual. The approaches currently in use:

**Server start / schema init:**
- Run `npm start` or `npm run dev`
- `getDb()` is called on start in `src/index.js` — if `initSchema` fails the server crashes visibly
- `initCache()` is awaited on start — logs output to console indicate success or failure

**Seed data:**
- `GET /run-seed?key=adminkey123` triggers `src/db/seed.js` and logs `✅ Seeded N deals and N services` to stdout
- Verify via admin panel at `/admin`

**Webhook verification:**
- Manual GET to `/webhook?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...`
- Verify 200 + challenge echoed back

**Chatbot flows:**
- Manual messages sent via WhatsApp / Instagram / Facebook test accounts
- Web widget tested in browser via `public/widget.js` loaded from `src/index.js`

**Admin API:**
- Manual browser interactions with the admin panel at `/admin`
- Network tab in DevTools to inspect request/response shapes

**Voice call:**
- Manual in-browser test by clicking the call button in the widget; logs visible in server stdout under `[call]` and `[TOOL CALL RAW PAYLOAD]` / `[TOOL CALL RESULT]`

## Highest-Value Test Targets (Priority Order)

### 1. Booking State Machine — `src/replies/booking.js`

The most complex module with the most pure-function helpers. All helpers are deterministic and side-effect-free (except `saveBooking` and the DB-reading helpers). High test value for low effort.

**Pure helpers that need no mocking:**
```js
isValidName('Ahmad')          // true
isValidName('123')            // false
extractName('mera naam Ali hai')  // 'Ali'
isValidPhone('+923001234567') // true
isValidPhone('abc')           // false
extractPhone('mera number 03001234567 hai')  // '03001234567'
isValidDate('tomorrow')       // true
isValidDate('2020-01-01')     // false (past)
isValidDate('30 March')       // depends on current date
parseTimeTo24h('2pm')         // '14:00'
parseTimeTo24h('2 baje')      // '14:00'
parseTimeTo24h('11:30 AM')    // '11:30'
normalizeDateToISO('today')   // 'YYYY-MM-DD' (current date)
normalizeDateToISO('kal')     // tomorrow's date
```

**Helpers requiring DB mock:**
- `getServiceNames()` — reads `services` table
- `getActiveStaff(branchName)` — reads `staff` + `branches`
- `getSalonTiming(dateStr)` — reads `salon_timings`
- `saveBooking(data, platform)` — writes to `bookings`

### 2. Validation Helpers — `src/index.js`

Three pure/near-pure functions with well-defined contracts:

```js
// validateBookingBody
validateBookingBody({ customer_name: '', phone: '03001234567', ... })
// → ['customer_name']

validateBookingBody({ customer_name: 'Ali', phone: '', service: '', ... })
// → ['phone', 'service', ...]

// checkBookingTiming — requires DB mock for salon_timings
// checkStaffBranch — requires DB mock for staff and branches
```

### 3. Session Management — `src/core/session.js`

Pure in-memory logic with no external dependencies. Entirely testable without mocks:

```js
// setSession + getSession round-trip
setSession('user1', { state: 'ASK_NAME' });
getSession('user1');  // → { state: 'ASK_NAME', lastUpdated: ... }

// Expiry
// Mock Date.now() to simulate TTL elapsed
isSessionExpired({ lastUpdated: Date.now() - 11 * 60 * 1000 }, 10); // true
isSessionExpired({ lastUpdated: Date.now() }, 10);                   // false

// clearSession
clearSession('user1');
getSession('user1');  // → null
```

### 4. Intent Routing — `src/core/router.js`

`routeMessage()` dispatches to reply functions based on `detectIntent()` return value. Test by mocking `detectIntent` to return each intent and verifying the correct reply function is called.

### 5. Cache Layer — `src/cache/salonDataCache.js`

`patchCache` logic is testable with an in-memory `_cache` object. The `saveAtomic` / `initCache` disk operations need a tmp dir or mock for `fs`.

Key cases:
- `patchCache('deals', 'upsert', { id: 1, title: 'New' })` — updates existing item by id
- `patchCache('deals', 'upsert', { id: 99, title: 'New' })` — appends new item
- `patchCache('deals', 'delete', { id: 1 })` — removes item
- `patchCache('deals', 'replace', [...])` — full replacement
- `patchCache('salonTimings', 'upsert', { day_type: 'workday', ... })` — keyed object update

### 6. Platform Webhook Handlers — `src/handlers/whatsapp.js`, `instagram.js`, `facebook.js`

Parse incoming Meta webhook payloads. Test by constructing payloads and asserting `routeMessage` is called with the correct `(userId, text, platform)` arguments. Requires mocking `routeMessage` and `send`.

**Example WhatsApp payload for test fixtures:**
```json
{
  "object": "whatsapp_business_account",
  "entry": [{
    "changes": [{
      "value": {
        "messages": [{ "from": "923001234567", "type": "text", "text": { "body": "book" } }],
        "metadata": { "phone_number_id": "101" }
      }
    }]
  }]
}
```

**Non-message payloads that should be ignored (no-op paths):**
- `value.messages` absent (status update)
- `message.type !== 'text'`

## Recommended Testing Stack

**Framework:** Jest (available via `npm install --save-dev jest`) or Vitest (lighter, ESM-friendly)

**Mocking:**
- `jest.mock()` / `vi.mock()` for module-level mocks
- `jest.spyOn()` / `vi.spyOn()` for individual function mocks
- `better-sqlite3` in tests: use an in-memory DB (`new Database(':memory:')`) rather than mocking

**HTTP mocking for Meta/Anthropic/Google API calls:**
- `nock` for axios-based calls in `metaSender.js`
- `jest.mock('@anthropic-ai/sdk')` for intent detection
- `jest.mock('@google/genai')` for voice session in `apiCallLive.js`

**File system mocking:**
- `jest.mock('fs')` or use a temp directory for `salonDataCache.js` tests

## Suggested Test File Layout

When tests are added, the convention for this codebase should be a separate `tests/` directory at the project root (not co-located), since all source is under `src/` and the codebase follows no framework conventions:

```
tests/
  unit/
    replies/
      booking.test.js      ← pure helpers: isValidName, extractName, parseTimeTo24h, etc.
      prices.test.js
      deals.test.js
    core/
      session.test.js
      router.test.js
      intent.test.js
    index/
      validateBookingBody.test.js
      checkStaffBranch.test.js
      checkBookingTiming.test.js
    cache/
      salonDataCache.test.js
  integration/
    handlers/
      whatsapp.test.js
      instagram.test.js
      facebook.test.js
    routes/
      bookings.test.js
      branches.test.js
      staff.test.js
```

## Setup Pattern for Future Tests

**In-memory DB pattern:**
```js
const Database = require('better-sqlite3');
const { initSchema } = require('../../src/db/database'); // would need to export initSchema

let db;
beforeEach(() => {
  db = new Database(':memory:');
  initSchema(db);
});
afterEach(() => {
  db.close();
});
```

**Mocking `getDb()` to return in-memory DB:**
```js
jest.mock('../../src/db/database', () => ({
  getDb: jest.fn(() => db),  // db from beforeEach
  getSettings: jest.fn(() => ({ currency: 'Rs.' })),
  invalidateSettingsCache: jest.fn(),
}));
```

**Testing booking pure helpers (no setup needed):**
```js
const { isValidName, extractName, parseTimeTo24h, isValidDate } = require('../../src/replies/booking');

describe('isValidName', () => {
  it('accepts plain Latin name', () => expect(isValidName('Ahmad')).toBe(true));
  it('accepts Urdu name', () => expect(isValidName('احمد')).toBe(true));
  it('rejects digits', () => expect(isValidName('123')).toBe(false));
  it('rejects too-short input', () => expect(isValidName('A')).toBe(false));
});

describe('parseTimeTo24h', () => {
  it('converts 2pm → 14:00', () => expect(parseTimeTo24h('2pm')).toBe('14:00'));
  it('converts 2 baje → 14:00', () => expect(parseTimeTo24h('2 baje')).toBe('14:00'));
  it('converts 11:30 AM → 11:30', () => expect(parseTimeTo24h('11:30 AM')).toBe('11:30'));
  it('converts 14:00 → 14:00', () => expect(parseTimeTo24h('14:00')).toBe('14:00'));
});
```

Note: `isValidName`, `extractName`, `parseTimeTo24h`, and other helpers in `src/replies/booking.js` are **not currently exported**. They would need to be added to `module.exports` before they can be unit tested.

## Critical Risk Areas With No Test Coverage

These are the areas where an undetected regression would cause the most user-facing damage:

| Area | Risk | File |
|------|------|------|
| `parseTimeTo24h` — "baje" parsing | Voice bookings saved with wrong time | `src/replies/booking.js` |
| `normalizeDateToISO` — relative date words | Bookings saved with wrong date | `src/replies/booking.js` (duplicated in `src/server/apiCallLive.js`) |
| `checkBookingTiming` — minute arithmetic | Times at boundary (open/close exactly) accepted or rejected incorrectly | `src/index.js` |
| `validateBookingBody` — past date check | Past-date bookings accepted via admin panel | `src/index.js` |
| `patchCache` upsert/delete — id coercion | Cache diverges from DB; stale data served to voice callers | `src/cache/salonDataCache.js` |
| `isSessionExpired` — TTL check | Sessions expire too early or never expire | `src/core/session.js` |
| `initSchema` — migration guard | `staff_id` / `staff_name` columns re-added on upgrade, causing crash | `src/db/database.js` |

---

*Testing analysis: 2026-04-02*
