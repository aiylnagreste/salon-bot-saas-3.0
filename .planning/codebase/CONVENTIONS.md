# Coding Conventions

**Analysis Date:** 2026-04-02

## Naming Patterns

**Files:**
- `camelCase.js` for all source files: `salonDataCache.js`, `metaSender.js`, `apiCallLive.js`
- Platform handler files use platform names: `whatsapp.js`, `instagram.js`, `facebook.js` in `src/handlers/`
- Module files describe their purpose: `intent.js`, `session.js`, `router.js`, `auth.js`, `database.js`, `seed.js`
- Admin frontend files are flat names: `panel.js`, `panel.css`

**Functions:**
- `camelCase` for all function names throughout
- Boolean-returning helpers prefixed `is`: `isValidName`, `isValidPhone`, `isValidDate`, `isValidTime`, `isWeekendDate`, `isSessionExpired`
- Data-extraction helpers prefixed `extract`: `extractName`, `extractPhone`, `extractDate`, `extractTime`
- Reply generators prefixed `get…Reply`: `getPricesReply`, `getDealsReply`, `getBranchesReply`, `getServiceListReply`
- Format/normalize helpers prefixed `format` or `normalize`: `formatTime12h`, `normalizeDateToISO`
- DB-accessing helpers prefixed `get`: `getDb`, `getSession`, `getCache`, `getServiceNames`, `getActiveStaff`, `getSalonTiming`
- Verb-noun for actions: `saveBooking`, `setupCallServer`, `initCache`, `patchCache`, `clearSession`
- Validation helpers prefixed `check` or `validate`: `checkStaffBranch`, `checkBookingTiming`, `validateBookingBody`
- Private module-level variables prefixed `_`: `_cache`, `_writeQueue`, `_settingsCache`

**Variables:**
- `camelCase` throughout: `custName`, `staffId`, `branchName`, `normalizedDate`, `timingRow`
- State machine step names are SCREAMING_SNAKE_CASE string literals: `'ASK_NAME'`, `'ASK_PHONE'`, `'ASK_SERVICE'`, `'ASK_BRANCH'`, `'ASK_STAFF'`, `'ASK_DATE'`, `'ASK_TIME'`
- Intent names are SCREAMING_SNAKE_CASE string literals: `'PRICE'`, `'BOOKING'`, `'SERVICE_DETAIL'`, `'DEALS'`, `'BRANCH'`, `'UNKNOWN'`, `'CANCEL'`
- Module-level constants in UPPER_SNAKE_CASE: `SESSION_TTL_MS`, `GRAPH_API_VERSION`, `BASE_URL`, `FALLBACK_MESSAGE`, `CACHE_FILE`, `CACHE_TMP`
- Admin-panel state variables prefixed `all`: `allBranches`, `allStaff`, `allRoles`, `allTimings` (in `public/admin/panel.js`)
- Validation error arrays always named `errs`: `const errs = [];`

**Module exports:**
- Named exports with object destructuring exclusively: `module.exports = { handleBookingStep }`, `module.exports = { getDb, getSettings, invalidateSettingsCache }`
- No default exports anywhere; always `module.exports = { ... }`
- No barrel index files; each module is imported by direct path

## Code Style

**Formatting:**
- No Prettier or ESLint config files present — style is manually consistent
- 2-space indentation in all files under `src/` **except** `src/server/apiCallLive.js` which uses 4-space indentation (file added later, deviates from the rest)
- Single quotes for strings universally, except one double-quoted require in `src/index.js`: `require("./server/apiCallLive.js")` — minor inconsistency
- Semicolons always present at statement endings
- Arrow functions for short callbacks and map/filter: `rows.forEach(r => { result[r.key] = r.value; })`
- Template literals for multi-token strings: `` `[${timestamp()}] INFO` ``, `` `Booking confirmed for ${custName}` ``
- Optional chaining used freely: `req.body?.object`, `body.entry?.[0]`, `cache?.services?.length`
- Nullish coalescing-style fallbacks via `||`: `staff_id || null`, `notes || null`, `branch_id || null`, `platform || 'chat'`

**Comment style:**
- Section dividers with `─` box-drawing characters and banner labels (established pattern, use for new sections):
  ```js
  // ── Booking validation helpers ────────────────────────────────────────────────
  ```
- Inline comments explain non-obvious logic:
  ```js
  // FIX: role filter moved into WHERE clause. Previously was in ORDER BY which is invalid SQL.
  // Acknowledge immediately — Meta requires 200 within 5 seconds
  // Prune expired sessions every 5 minutes
  ```
- JSDoc block comments only in `src/cache/salonDataCache.js` (the only file using them systematically)
- Commented-out code blocks left in-place with `//` in `src/server/apiCallLive.js` — old validation approach and disabled `get_staff` tool

## Import Organization

**Order used consistently across all files:**
1. `require('dotenv').config()` — first when env vars are needed at load time
2. Node built-ins: `require('fs')`, `require('path')`, `require('http')`
3. Third-party packages: `require('express')`, `require('better-sqlite3')`, `require('axios')`, `require('@google/genai')`
4. Internal modules — deepest dependencies first (utils, db), then mid-level (core, cache, handlers), then feature-level (replies, server)

**No path aliases.** All imports use relative paths: `require('../db/database')`, `require('./utils/logger')`, `require('../../data')`.

## DB Access Patterns

**Singleton pattern:** `getDb()` from `src/db/database.js` returns the single `better-sqlite3` instance. Always called at the top of a function body that needs it — never stored at module scope in consuming modules.

```js
// Correct pattern — used throughout src/
function someFunction(args) {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM table WHERE col = ?').all(value);
  return rows;
}
```

**Parameterized queries always.** Never string-concatenate SQL. Named params (`@name`) for multi-field upserts; positional `?` for simple lookups:
```js
// Named params — upsert pattern in src/index.js admin routes
const upsert = db.prepare(`
  INSERT INTO deals (id, title, description, active, updated_at)
  VALUES (@id, @title, @description, @active, datetime('now'))
  ON CONFLICT(id) DO UPDATE SET title = excluded.title, ...
`);
upsert.run({ id: deal.id, title: deal.title, ... });

// Positional params — everywhere else
db.prepare('SELECT * FROM staff WHERE id = ?').get(staff_id);
db.prepare('SELECT * FROM salon_timings WHERE day_type = ?').get(dayType);
```

**Transactions for multi-row writes.** The `db.transaction(() => { ... })()` IIFE pattern wraps all upsert+delete operations on deals, services, and timings in `src/index.js`:
```js
const runAll = db.transaction(() => {
  for (const id of toDelete) { db.prepare('DELETE FROM deals WHERE id = ?').run(id); }
  for (const deal of deals) { upsert.run({ ... }); }
});
runAll();
```

**Synchronous only.** `better-sqlite3` is sync. No `await` on DB calls anywhere. All DB operations complete inline.

**Prepared statements reused within a handler.** Within a single request handler, `db.prepare()` is called once before a loop, not inside the loop body.

**Post-insert fetch pattern.** After every INSERT, the new row is fetched by `lastInsertRowid` and returned to the client:
```js
const r = db.prepare('INSERT INTO branches (number, name, address, map_link, phone) VALUES (?, ?, ?, ?, ?)').run(...);
const newBranch = db.prepare('SELECT * FROM branches WHERE id = ?').get(r.lastInsertRowid);
res.json(newBranch);
```

**Settings in-memory cache.** `src/db/database.js` keeps `_settingsCache` at module scope. `getSettings()` populates on first call and reuses; `invalidateSettingsCache()` nulls it when currency is changed.

## API Response Shapes

**Admin mutations return these shapes — follow these exactly:**

| Route type | Success shape | Failure shape |
|---|---|---|
| `DELETE` | `{ ok: true }` | `{ ok: false, error: string }` or `{ error: string }` |
| `PATCH` | `{ ok: true }` | `{ ok: false, error: string }` |
| `PUT` (booking) | `{ ok: true }` | `{ ok: false, error: string }` — status 400 |
| `PUT` (settings) | `{ ok: true }` | `{ error: string }` — status 400 |
| `POST` (booking) | full inserted row (no wrapper) | `{ ok: false, error: string }` — status 400 |
| `POST` (branch/staff/role) | full inserted row (no wrapper) | `{ error: string }` — status 400 |
| `POST` (deals/services) | `{ ok: true, deals: [...] }` | `{ ok: false, error: string }` |

Note the inconsistency: booking routes use `{ ok: false, error }` while settings routes (branches, staff, roles, timings) use `{ error }` without `ok`. New routes should follow the `{ ok: false, error }` pattern.

**Read endpoints (GET) return raw data:**
- Arrays directly: `res.json(deals)`, `res.json(services)`, `res.json(clients)`, `res.json(staff)`
- Keyed objects for settings: timings → `{ workday: {...}, weekend: {...} }`, general → `{ currency: 'Rs.' }`

**Chat API (`POST /api/chat`) shape:**
```js
// Success
{ reply: "Bot response string" }
// Error
{ error: "message and sessionId required" }   // 400
{ error: "Something went wrong" }              // 500
```

**Seed endpoint (`GET /run-seed`) returns `{ ok: true }` on success, raw `err.toString()` string (not JSON) on failure.** This is a known inconsistency — it's a dev-only endpoint.

## Error Handling

**Route handlers: try/catch wrapping all DB work.**
```js
app.post('/admin/deals', requireAdminAuth, (req, res) => {
  try {
    const db = getDb();
    // ... validation and DB work ...
    res.json({ ok: true, deals: updated });
  } catch (err) {
    logger.error('[admin] Save deals error:', err.message);
    res.json({ ok: false, error: err.message });
  }
});
```

**Validation before DB work.** Build an `errs` array, return early if non-empty:
```js
const errs = validateBookingBody(req.body);
if (errs.length) return res.status(400).json({ ok: false, error: `Required fields missing or invalid: ${errs.join(', ')}` });
```

**Reply functions never throw — always return a fallback string on error:**
```js
function getPricesReply() {
  try {
    // ... DB work and formatting ...
    return reply;
  } catch (err) {
    console.error('[prices] DB error:', err.message);
    return 'Sorry, I could not load prices right now. Please try again shortly.';
  }
}
```

**Booking step errors return user-facing strings.** The step handler never throws:
```js
if (!isValidName(text)) {
  return '⚠️ Please enter your *full name* (letters only).';
}
```

**Validation helpers return `null` (no error) or a string (error message).** Callers check with `if (err) return res.status(400).json(...)`:
```js
function checkStaffBranch(staff_id, branch, db) {
  if (!staff_id) return null;   // optional — skip
  const staff = db.prepare('SELECT * FROM staff WHERE id = ?').get(staff_id);
  if (!staff) return 'Selected staff member not found.';
  // ...
  return null;  // all good
}
```

**Cache patch errors are fire-and-forget** — never block HTTP response:
```js
patchCache('bookings', 'upsert', newBooking).catch(e => logger.error('[cache] bookings upsert:', e.message));
```

**`src/server/apiCallLive.js` exception:** Uses raw `console.log`/`console.error` instead of `logger`, and does not follow the try/catch-in-routes pattern since it is a WebSocket server, not Express routes.

## Logging Approach

**Logger module:** `src/utils/logger.js` exports `logger.info()`, `logger.error()`, `logger.warn()`. All output is ISO-timestamp-prefixed: `[2026-04-02T12:00:00.000Z] INFO ...`.

**Use `logger` (not `console`) in all production code under `src/` except `apiCallLive.js` and `seed.js`:**
```js
logger.info(`[WhatsApp] From: ${userId} | Message: ${text}`);
logger.error('[admin] Save deals error:', err.message);
logger.warn('[cache] SALON_DATA_KEY not set in .env — using default dev key.');
```

**Log tag convention:** Always prefix with a bracket-wrapped component label: `[WhatsApp]`, `[admin]`, `[cache]`, `[intent]`, `[call]`, `[metaSender]`, `[Webhook]`. This is how all existing log lines are written.

**Known non-conforming files that use raw `console` instead of `logger`:**
- `src/replies/booking.js` — debug traces: `[BOOKING FIELDS]`, `[BOOKING ROUTER]`
- `src/replies/prices.js`, `src/replies/deals.js` — error catches in reply functions
- `src/core/intent.js` — API error catch
- `src/core/router.js` — routing debug trace
- `src/server/apiCallLive.js` — all voice call logging
- `src/db/seed.js` — seed progress output

## Channel-Aware Reply Formatting

Reply functions that produce user-facing messages must branch on `platform` when the message style differs by channel. The established pattern (from `src/replies/booking.js` ASK_TIME step):

```js
const plt = session.platform || 'whatsapp';

if (plt === 'instagram' || plt === 'facebook') {
  return `Unavailable time selected.\n\nOur ${label} hours are ${openFmt} to ${closeFmt}.\nPlease reply with a time within that range.`;
}
if (plt === 'webchat' || plt === 'voice') {
  return `Selected time is not available. Please choose a slot between ${openFmt} and ${closeFmt}.`;
}
// Default: WhatsApp — bold markdown + emoji
return `⚠️ That time is outside our ${label} hours.\n\n🕐 Available: *${openFmt} – ${closeFmt}*\n\nPlease choose a time within that range.`;
```

**Rules:**
- WhatsApp: `*bold*` markdown, emoji decorators
- Instagram/Facebook: plain text, no `*` markers, no emoji (Meta Messenger does not render WA-style markdown)
- webchat/voice: concise plain text, no markdown

## Frontend Conventions (public/admin/panel.js)

**XSS protection is mandatory.** All user data inserted into `innerHTML` must use `esc()`:
```js
td.innerHTML = esc(booking.customer_name);
```
Never set innerHTML directly from untrusted input.

**State variables prefixed `all`.** Module-level arrays/objects populated at page init and refreshed after mutations: `allBranches`, `allStaff`, `allRoles`, `allTimings`.

**`allTimings` shape:** `{ workday: { open_time: 'HH:MM', close_time: 'HH:MM' }, weekend: { ... } }` — loaded from `GET /admin/api/settings/timings` at init.

**Toast for feedback, not `alert()`.** Use `showToast(message, type)` for success/error messages shown to the admin user.

**Field-level validation errors.** Write to `<div id="…-error" class="field-error">` elements via `.textContent`, not via toast. Elements are positioned immediately below their input in the booking modal.

**Booking modal field IDs:** `#bm-name`, `#bm-phone`, `#bm-service`, `#bm-branch`, `#bm-staff`, `#bm-date`, `#bm-time`, `#bm-status`, `#bm-notes`. Error divs: `#bm-time-error`, `#bm-date-error`.

**`populateStaffSelect(selectedId, branchName)` signature.** Always pass `branchName` when a branch has been selected so staff are filtered. Omit (or pass `null`) when opening the modal fresh with no branch selected yet.

---

*Convention analysis: 2026-04-02*
