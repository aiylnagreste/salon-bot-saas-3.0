# Codebase Concerns

**Analysis Date:** 2026-04-02

---

## Security Considerations

**Hardcoded fallback secret key in production code:**
- Risk: The seed endpoint (`GET /run-seed`) uses a hardcoded string `"adminkey123"` as its only auth check — `src/index.js` line 597. Anyone who knows the URL can trigger destructive DELETE+re-insert of all deals and services with no env-var protection. The `/salon-data.json` endpoint also falls back to `"adminkey123"` if `SALON_DATA_KEY` is unset (`src/index.js` line 583), exposing the full DB cache publicly if the env var is missing.
- Files: `src/index.js` lines 583, 597
- Current mitigation: None — hardcoded fallback is always active.
- Recommendations: Guard `/run-seed` behind `NODE_ENV !== 'production'` or remove it entirely from production builds; add a startup assertion that `SALON_DATA_KEY` is set.

**No rate limiting on any endpoint:**
- Risk: The `/api/chat` endpoint calls Claude Haiku on every request. A bad actor can spam it with no throttle, running up unlimited Anthropic API charges. Similarly, `/api/call` opens a full Gemini Live Audio WebSocket per connection — an uncapped flood of connections would exhaust GEMINI_API_KEY quota and server memory simultaneously.
- Files: `src/index.js` (all routes), `src/server/apiCallLive.js`
- Current mitigation: `WIDGET_ALLOWED_ORIGINS` only controls CORS headers and WebSocket upgrade origin checks — a server-side caller bypasses both.
- Recommendations: Add `express-rate-limit` on `/api/chat`; add a concurrent active WebSocket connection cap per IP in `setupCallServer`.

**Admin login has no rate limiting or lockout:**
- Risk: `POST /admin/login` (`src/index.js` line 97) performs a plain string compare with no rate limit, no attempt counter, and no lockout. Brute-force is unrestricted.
- Files: `src/index.js` lines 97–112
- Current mitigation: None beyond requiring knowledge of the URL.
- Recommendations: Add rate limiting on `/admin/login` (e.g. max 5 attempts per minute per IP); log failed attempts.

**Admin session uses a static token with no server-side expiry:**
- Risk: `requireAdminAuth` in `src/admin/auth.js` line 5 compares `req.cookies.adminToken === process.env.ADMIN_SESSION_SECRET`. There is no server-side session store, no server-side TTL, and no session invalidation on logout. Logout only clears the client cookie (`Max-Age=0`) — if the token leaks it is valid indefinitely.
- Files: `src/admin/auth.js`, `src/index.js` lines 100–117
- Current mitigation: Cookie is `HttpOnly; SameSite=Strict; Max-Age=86400`. The 24-hour Max-Age is client-enforced only.
- Recommendations: Store sessions server-side (SQLite or Redis) with a real TTL; invalidate on logout by deleting the server-side record.

**`x-admin-token` header accepted for admin auth:**
- Risk: `requireAdminAuth` (`src/admin/auth.js` line 2) also accepts `req.headers['x-admin-token']`. This undocumented header has no CORS restriction; any script with the token value can call admin API routes cross-origin without a cookie.
- Files: `src/admin/auth.js`
- Current mitigation: None beyond knowing the token value.
- Recommendations: Remove the header path, or restrict it to server-to-server use with a separate secret.

**No CSRF protection on admin mutation routes:**
- Risk: All admin `POST`/`PUT`/`DELETE`/`PATCH` routes rely purely on the `adminToken` cookie. `SameSite=Strict` provides partial mitigation but does not guard against same-origin attacks.
- Files: `src/index.js` (all `/admin/api/` mutation routes)
- Current mitigation: `SameSite=Strict` on the cookie.
- Recommendations: Add a CSRF token (double-submit cookie pattern or `csurf`) to all state-changing admin routes.

**Booking status field accepts any arbitrary string:**
- Risk: `PATCH /admin/api/bookings/:id/status` (`src/index.js` line 352) writes `req.body.status` directly to the DB with zero validation. No allowlist for values such as `confirmed`, `pending`, `cancelled`. An undefined or empty body writes garbage data.
- Files: `src/index.js` lines 350–357
- Current mitigation: Route is protected by `requireAdminAuth`.
- Recommendations: Validate `status` against an explicit allowlist before writing.

**`map_link` URL validation is too permissive:**
- Risk: Branch `map_link` is only validated as starting with `"http"` (`src/index.js` lines 391, 410). Any arbitrary URL passes. If the value is ever rendered as an unsanitized `href`, it could accept `javascript:` or other protocol schemes.
- Files: `src/index.js` lines 391, 410
- Current mitigation: The field is rendered via the admin panel where values are escaped.
- Recommendations: Validate that `map_link` starts with `https://` and optionally restrict to known maps domains.

**PII logged to stdout in production:**
- Risk: `src/replies/booking.js` logs customer name and phone at every booking step (lines 279, 294, 323, 346, 391, 404, 429, 482). `src/server/apiCallLive.js` line 196 logs booking fields including phone for voice bookings. `src/core/router.js` line 19 logs the raw message text with user ID on every chat message.
- Files: `src/replies/booking.js`, `src/server/apiCallLive.js`, `src/core/router.js`
- Current mitigation: None — all values go to stdout as-is.
- Recommendations: Remove or gate the `[BOOKING FIELDS]` debug lines behind a `DEBUG=true` env flag; redact phone numbers in router logs.

---

## Tech Debt

**Duplicate `GET /admin` route registration:**
- Issue: `app.get('/admin', requireAdminAuth, ...)` is registered twice in `src/index.js` — at line 121 and again at line 240. Express silently uses the first match; the second registration is dead code.
- Files: `src/index.js` lines 121 and 240
- Impact: Any change applied to the second handler has no effect. The duplication suggests changes are being made without full awareness of the file structure.
- Fix approach: Delete the duplicate at line 240.

**`staff.role` is a free-text column; `staff_roles` FK join in `apiCallLive.js` is broken:**
- Issue: The `staff` table schema (`src/db/database.js` line 84) stores `role` as `TEXT NOT NULL`. A separate `staff_roles` table enforces valid role names but there is no `role_id` foreign key on `staff`. `src/server/apiCallLive.js` line 95 runs `LEFT JOIN staff_roles r ON s.role_id = r.id` — `role_id` does not exist on `staff`, so the JOIN silently returns `null` for `r.name` on every row.
- Files: `src/db/database.js` line 84, `src/server/apiCallLive.js` line 95
- Impact: The `get_staff` voice tool always renders every staff member as `(Stylist)` regardless of their actual role, because the JOIN never matches.
- Fix approach: Either add a `role_id INTEGER REFERENCES staff_roles(id)` migration, or rewrite the `apiCallLive.js` query to use `s.role` directly (as all other queries do).

**`normalizeDateToISO` and `isWeekendDate` are duplicated across three files:**
- Issue: Nearly identical date-parsing logic exists in `src/replies/booking.js` (lines 202–244), `src/server/apiCallLive.js` (lines 9–48), and `src/replies/booking.js` `isWeekendDate` (lines 202–222). The two copies already differ slightly — `apiCallLive.js` handles `"parson"` / `"day after tomorrow"` in `normalizeDateToISO`; `booking.js` handles them only in `isWeekendDate`.
- Files: `src/replies/booking.js` lines 202–244, `src/server/apiCallLive.js` lines 9–48
- Impact: Bug fixes or new language keywords must be applied in multiple places; divergence has already begun.
- Fix approach: Extract into `src/utils/dateUtils.js` and import from both consumers.

**`saveBooking` in `src/replies/booking.js` does not patch the cache:**
- Issue: When a booking is created via the chatbot (WhatsApp/Instagram/Facebook/webchat), `saveBooking()` (`src/replies/booking.js` lines 45–61) inserts into the DB but never calls `patchCache('bookings', 'upsert', newBooking)`. The voice path in `apiCallLive.js` line 206 correctly patches the cache.
- Files: `src/replies/booking.js` lines 45–61
- Impact: `GET /salon-data.json` returns stale booking data for all chat-channel bookings until the next server restart.
- Fix approach: After the `db.prepare(...).run(...)` call in `saveBooking`, fetch the inserted row and call `patchCache`.

**`saveBooking` has no return value:**
- Issue: `saveBooking()` (`src/replies/booking.js` lines 45–61) discards the insert result. The caller cannot access the new booking's ID for logging or cache patching.
- Files: `src/replies/booking.js` lines 45–61, 485
- Fix approach: Return `db.prepare('SELECT * FROM bookings WHERE id = ?').get(r.lastInsertRowid)` (same pattern as `src/index.js` line 327).

**Foreign key enforcement is not enabled:**
- Issue: `src/db/database.js` sets `journal_mode = WAL` (line 26) but never executes `PRAGMA foreign_keys = ON`. SQLite disables FK enforcement by default. The `ON DELETE SET NULL` constraints on `staff.branch_id` and `bookings.staff_id` exist as schema documentation only — they are not enforced at runtime.
- Files: `src/db/database.js` line 26
- Impact: Deleting a branch does not null out `staff.branch_id`; deleting a staff member does not null out `bookings.staff_id`. Orphaned FK values accumulate silently.
- Fix approach: Add `db.pragma('foreign_keys = ON')` immediately after `db.pragma('journal_mode = WAL')`.

**`console.log`/`console.error` used throughout instead of `logger`:**
- Issue: `src/server/apiCallLive.js` uses `console.log`/`console.error` throughout (lines 196, 206, 242, 367, 386, 395, 403, 412, 416, 431, 453, 458, 464, 470). `src/replies/booking.js` uses `console.log` at every booking step. `src/core/router.js` line 19, `src/core/intent.js` line 59, `src/replies/prices.js`, and `src/replies/deals.js` use `console.error`. The project convention is `logger` from `src/utils/logger.js`.
- Files: `src/server/apiCallLive.js`, `src/replies/booking.js`, `src/core/router.js`, `src/core/intent.js`, `src/replies/prices.js`, `src/replies/deals.js`
- Impact: Inconsistent log formatting; timestamps missing from `console.*` output; no easy way to redirect or filter logs.
- Fix approach: Replace all `console.*` calls in `src/` with `logger.info`/`logger.error`.

**Commented-out code blocks left in `apiCallLive.js`:**
- Issue: `src/server/apiCallLive.js` contains a large commented-out DB-only lookup block at lines 127–138 and a commented-out `get_staff` tool declaration at lines 313–325. The `get_staff` function implementation (lines 79–103) is still present but unreachable via tool calls.
- Files: `src/server/apiCallLive.js`
- Impact: Dead code inflates file size and creates confusion about what is active.
- Fix approach: Remove the commented-out blocks; if `get_staff` is intentionally disabled, delete its implementation or add an explicit explanatory comment.

**`src/index.js` (647 lines) and `public/admin/panel.js` (1052 lines) are monoliths:**
- Issue: All Express routes and all admin UI logic live in single files with no module boundaries. The duplicate `GET /admin` registration (lines 121 and 240 of `src/index.js`) is direct evidence of changes being made without awareness of the full file.
- Files: `src/index.js`, `public/admin/panel.js`
- Impact: High cognitive load when adding new routes or UI features; accidental collisions between sections.
- Fix approach: Split `src/index.js` into Express Router files by domain (`routes/admin.js`, `routes/webhook.js`, `routes/api.js`). Split `panel.js` by tab/section.

---

## Known Bugs

**`checkBookingTiming` and `isWeekendDate` use `new Date(date)` without timezone guard:**
- Symptoms: ISO date strings like `"YYYY-MM-DD"` parsed with `new Date(date)` are interpreted as UTC midnight. In timezones behind UTC (e.g. UTC-5), `new Date("2026-04-06").getDay()` returns Saturday (6) even though it is still Friday (5) locally. This causes wrong `workday`/`weekend` classification near weekend boundaries.
- Files: `src/index.js` line 301 (`checkBookingTiming`), `src/replies/booking.js` lines 202–222 (`isWeekendDate`), `src/server/apiCallLive.js` lines 31–48 (`isWeekendForDate`)
- Trigger: Any booking made for a date near a weekend boundary when the server is not running in UTC.
- Workaround: Run the server with `TZ=UTC` environment variable to avoid the issue.

**`get_staff` voice tool JOIN on non-existent `role_id` column silently returns wrong data:**
- Symptoms: Every staff member shown via voice is displayed as `(Stylist)` regardless of actual role.
- Files: `src/server/apiCallLive.js` line 95
- Trigger: Every call to the `get_staff` voice tool.
- Workaround: None at runtime; requires code fix.

**`parseInt(req.query.limit)` passes `NaN` to SQLite for non-numeric input:**
- Symptoms: `GET /admin/api/bookings?limit=abc` passes `NaN` to `db.prepare(...).all(...args)`. `better-sqlite3` converts `NaN` to `null` for a bound parameter, producing undefined behaviour with no error response.
- Files: `src/index.js` line 265
- Trigger: Any request with a non-numeric `limit` query parameter.
- Workaround: Use numeric-only values for `limit`.

**Cookie parser truncates values containing `=`:**
- Symptoms: The inline cookie parser at `src/index.js` lines 30–33 uses `.split('=').map(decodeURIComponent)`. Cookie values containing `=` (common in Base64-encoded tokens) are silently truncated at the first `=`, potentially breaking admin auth if `ADMIN_SESSION_SECRET` contains `=`.
- Files: `src/index.js` lines 30–33
- Trigger: Any `ADMIN_SESSION_SECRET` value containing `=`.
- Workaround: Use a secret that contains no `=` characters (e.g. a hex string).

**CANCEL intent clears session but does not handle the case of no active session:**
- Symptoms: If a user with no active booking session sends a message classified as `CANCEL`, the bot returns "Your booking process has been cancelled" — misleading since nothing was in progress.
- Files: `src/core/router.js` lines 32–35
- Trigger: Any message classified as `CANCEL` when no session is active for the user.
- Workaround: None at runtime.

**Chatbot-created bookings are absent from `salon-data.json` cache:**
- Symptoms: All bookings made through WhatsApp, Instagram, Facebook, or the web widget chat are not reflected in `salon-data.json` until the server restarts. Voice-created bookings are correct.
- Files: `src/replies/booking.js` lines 45–61
- Trigger: Every booking submitted via a chat channel.
- Workaround: Restart the server to trigger a full cache rebuild.

---

## Performance Bottlenecks

**Claude Haiku API is called unconditionally before session-aware routing:**
- Problem: `routeMessage` in `src/core/router.js` line 28 calls `detectIntent(messageText)` on every message, even when the user is already inside an active booking session. The API call result is discarded if a session is active (step 3 check happens after). This wastes one LLM API round-trip per message for every mid-booking user.
- Files: `src/core/router.js` lines 17–35
- Cause: Intent detection is not short-circuited by session state.
- Improvement path: Check `session && session.state?.startsWith('ASK_')` before calling `detectIntent`; dispatch directly to `handleBookingStep` without the API call.

**Cache rebuild loads all `bookings` rows on cold start:**
- Problem: `_buildFromDb()` in `src/cache/salonDataCache.js` line 61 fetches `SELECT * FROM bookings ORDER BY created_at DESC` with no LIMIT or date range. Over months/years of operation this can load thousands of rows into memory on every server restart.
- Files: `src/cache/salonDataCache.js` line 61
- Cause: No pagination or recency filter on the bookings cache query.
- Improvement path: Cache only recent bookings (e.g. last 90 days), or omit bookings from the persistent cache and query the DB directly for admin views.

**`axios` calls have no timeout configured:**
- Problem: `src/utils/metaSender.js` uses `axios.post` with no `timeout` option. A hung Meta Graph API response holds a Node.js async task open indefinitely.
- Files: `src/utils/metaSender.js`
- Cause: Default axios behaviour has no timeout.
- Improvement path: Add `{ timeout: 10000 }` to each `axios.post` call.

---

## Fragile Areas

**No input validation on `PATCH /admin/api/bookings/:id/status`:**
- Files: `src/index.js` lines 350–357
- Why fragile: `req.body.status` is written directly to the DB with no null/empty check and no allowlist. An accidental undefined body writes the string `"undefined"` as the booking status.
- Safe modification: Add null check and allowlist (`confirmed`, `pending`, `cancelled`, `no-show`) before this route is called programmatically.
- Test coverage: None.

**Branch deletion does not clean up staff assignments or booking references at runtime:**
- Files: `src/index.js` line 424, `src/db/database.js` line 85
- Why fragile: FK enforcement is off (see above). Deleting a branch via `DELETE /admin/api/settings/branches/:id` leaves `staff.branch_id` pointing to the deleted ID and leaves `cache.branches` patched without re-fetching affected staff. Staff whose branch was deleted appear with a stale branch in the cache.
- Safe modification: Enable `PRAGMA foreign_keys = ON` first; also re-fetch and re-patch `staff` cache slice after a branch deletion.
- Test coverage: None.

**Voice tool `create_booking` has no deduplication guard:**
- Files: `src/server/apiCallLive.js` lines 105–211
- Why fragile: If Gemini sends a `create_booking` tool call twice (e.g. due to network retry or model hallucination), two identical bookings are inserted into the DB with no check for an existing entry with the same phone+date+time.
- Safe modification: Add a uniqueness check before insert, or rely on a DB unique constraint on `(phone, date, time)`.
- Test coverage: None.

**`src/index.js` has both a commented-out `app.listen` block and an active one:**
- Files: `src/index.js` lines 629–633 (commented), 636–647 (active)
- Why fragile: The commented-out block at line 629 uses `getDb()` inside the listen callback; the active block at line 643 also calls `getDb()` but with `await initCache()` added. The commented code is left in place as potential confusion for future editors.
- Safe modification: Remove the commented-out `app.listen` block.
- Test coverage: N/A.

---

## Scaling Limits

**Single SQLite file — no horizontal scaling:**
- Current capacity: Suitable for one server process; SQLite WAL mode supports concurrent reads but only one writer.
- Limit: Multiple Node processes or servers cannot share the same SQLite file safely.
- Scaling path: Migrate to PostgreSQL; replace `better-sqlite3` sync API with an async client.

**In-process session store is lost on restart:**
- Current capacity: Single process; all booking session state lives in `src/core/session.js`'s `Map`.
- Limit: Sessions are lost on every server restart; horizontally scaled deployments cannot share sessions.
- Scaling path: Replace with Redis-backed sessions.

**Unbounded concurrent Gemini Live Audio WebSocket sessions:**
- Current capacity: Each active voice call holds one open WebSocket and one live Gemini session. Memory and Gemini API quota scale linearly with concurrent callers.
- Limit: No cap on concurrent connections exists in `src/server/apiCallLive.js`. A flood of simultaneous callers exhausts quota.
- Scaling path: Implement a per-IP connection limit and a global maximum concurrent sessions guard in `setupCallServer`.

---

## Dependencies at Risk

**Both `@google/generative-ai` and `@google/genai` are listed as dependencies:**
- Risk: `package.json` includes both `@google/generative-ai` (`^0.24.1`) and `@google/genai` (`^1.47.0`). Only `@google/genai` is used in the codebase. The older package is unused dead weight and may cause resolution conflicts as the SDK evolves.
- Impact: Unnecessary bundle size; potential future conflict if both packages export the same symbols.
- Migration plan: Remove `@google/generative-ai` from `package.json` and run `npm install`.

**`express` version `^4.19.2` — Express 5 is now stable:**
- Risk: The project is locked to Express 4. While not an immediate security risk, Express 4 will eventually become unmaintained.
- Impact: Low for now; will require async error handling changes when migrating to Express 5.
- Migration plan: Plan an upgrade to Express 5 once its ecosystem (e.g. `express-rate-limit`) is fully compatible.

---

## Test Coverage Gaps

**Zero tests exist in the entire project:**
- What's not tested: The 7-step booking state machine (`src/replies/booking.js`), all 25+ admin API routes (`src/index.js`), intent detection and fallback behaviour (`src/core/intent.js`), cache patch/rebuild logic (`src/cache/salonDataCache.js`), all date/time parsing helpers.
- Files: Entire `src/` tree; `public/admin/panel.js`.
- Risk: Any refactor to the booking flow, date parsing, cache logic, or admin API can silently break existing behaviour with no automated safety net.
- Priority: High — the booking state machine has complex branching (7 steps, platform-specific error messages, multiple input-extraction helpers) and is the most user-facing feature.

**Date/time parsing edge cases are untested:**
- What's not tested: `isValidDate` with year-boundary inputs (e.g. "31 December" in January); `parseTimeTo24h("12 baje")` (noon vs midnight ambiguity); `checkBookingTiming` when `salon_timings` row is absent; `validateBookingBody` with whitespace-only strings.
- Files: `src/replies/booking.js` lines 138–188, `src/index.js` lines 271–312
- Risk: Edge cases in user input produce silently wrong validations or incorrect bookings.
- Priority: High.

**Cache staleness scenarios are untested:**
- What's not tested: Behaviour when `salon-data.json` is corrupt on startup; concurrent `patchCache` calls with the write mutex; cold-start DB fallback in voice tool handlers.
- Files: `src/cache/salonDataCache.js`
- Risk: Corruption or race conditions during cache writes could cause the server to serve stale data or crash on startup with no recovery path tested.
- Priority: Medium.

---

*Concerns audit: 2026-04-02*
