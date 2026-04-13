# Architecture

**Analysis Date:** 2026-04-02

## Pattern Overview

**Overall:** Monolithic Express server with a multi-channel message routing layer

**Key Characteristics:**
- Single Node.js process handles all channels (WhatsApp, Instagram, Facebook, web widget, voice)
- Intent-driven routing: every chatbot message is classified by Claude Haiku before dispatch
- Synchronous SQLite (`better-sqlite3`) as the sole persistence layer
- In-memory session store for stateful booking conversations
- Persistent JSON cache (`data/salon-data.json`) mirrors DB for read-heavy voice tool handlers

## Entry Point

`src/index.js` is the only server entry point. It:
1. Loads env vars via `dotenv`
2. Registers all Express middleware and routes
3. Wraps Express in a `http.Server` to support WebSocket upgrades
4. Calls `setupCallServer(server)` from `src/server/apiCallLive.js` to attach the WebSocket voice endpoint at `/api/call`
5. Calls `initCache()` from `src/cache/salonDataCache.js` on startup

## Layers

**Platform Handlers (inbound):**
- Purpose: Parse raw webhook payloads from Meta; extract `userId` + `text`
- Location: `src/handlers/whatsapp.js`, `src/handlers/instagram.js`, `src/handlers/facebook.js`
- Pattern: Each handler calls `res.sendStatus(200)` immediately (Meta requires 200 within 5 s), then calls `routeMessage(userId, text, platform)` asynchronously, then calls `send(platform, userId, reply)` to return the response
- Depends on: `src/core/router.js`, `src/utils/metaSender.js`

**Chat Router:**
- Purpose: Classify intent and dispatch to the correct reply generator
- Location: `src/core/router.js`
- Exports: `routeMessage(userId, messageText, platform)`
- Flow:
  1. Check for expired session → return expiry message and clear
  2. Call `detectIntent(messageText)` → `intent` + optional `term`
  3. If `CANCEL` intent → clear session, return confirmation
  4. If active booking session (`session.state.startsWith('ASK_')`) → delegate to `handleBookingStep()`
  5. Otherwise route by intent: `PRICE` → `getPricesReply()`, `DEALS` → `getDealsReply()`, `BRANCH` → `getBranchesReply()`, `BOOKING` → `handleBookingStep()`, `SERVICE_LIST` → `getServiceListReply()`, `SERVICE_DETAIL` → `getServiceDetail(term)`, `UNKNOWN` → fallback message

**Intent Classifier:**
- Purpose: Classify a user message into one of 8 intents using Claude Haiku
- Location: `src/core/intent.js`
- Exports: `detectIntent(message)` — returns a string intent OR `{ intent: 'SERVICE_DETAIL', term }` for named-service queries
- Model: `claude-haiku-4-5-20251001`, `max_tokens: 20`
- Valid intents: `PRICE`, `DEALS`, `BOOKING`, `CANCEL`, `BRANCH`, `SERVICE_LIST`, `SERVICE_DETAIL`, `UNKNOWN`
- On API error falls back to `'UNKNOWN'`

**Session Store:**
- Purpose: Hold stateful booking conversation state per user
- Location: `src/core/session.js`
- Storage: `Map` keyed by `userId` (WhatsApp number, Instagram/Facebook sender ID, or web `sessionId`)
- TTL: 10 minutes (`SESSION_TTL_MS`); pruned by 5-minute `setInterval`
- Exports: `getSession`, `setSession`, `clearSession`, `isSessionExpired`
- State is lost on server restart — no DB persistence

**Reply Generators:**
- Purpose: Produce formatted string replies from DB data
- Location: `src/replies/`
- `prices.js` — `getPricesReply()`, `getServiceListReply()`, `getServiceDetail(term)`: query `services` table, group by branch, format with WhatsApp markdown
- `deals.js` — `getDealsReply()`: query active `deals`, format with emoji
- `branches.js` — `getBranchesReply()` and `getBranches()`: query `branches`, format address + phone + map_link
- `booking.js` — `handleBookingStep(userId, text, session, platform)`: 7-step state machine (see Booking Flow section)
- All functions return plain strings. WhatsApp `*bold*`/emoji markdown is the default; `booking.js` branches on `session.platform` for platform-safe error messages

**Admin Layer:**
- Purpose: Protect and serve the admin panel; expose all CRUD API routes
- Location: Auth middleware in `src/admin/auth.js`; all routes registered in `src/index.js`
- Auth: `requireAdminAuth` checks `req.cookies.adminToken` or `req.headers['x-admin-token']` against `process.env.ADMIN_SESSION_SECRET`
- Login/logout: `POST /admin/login` sets `HttpOnly` cookie; `GET /admin/logout` clears it
- All `/admin/api/*` routes require `requireAdminAuth`

**Database Layer:**
- Purpose: SQLite schema init, singleton connection, in-memory settings cache
- Location: `src/db/database.js`
- Exports: `getDb()` (lazy singleton, WAL mode), `getSettings()` (memoized key-value from `app_settings`), `invalidateSettingsCache()`
- Schema initialised in `initSchema(db)` which also performs conditional column migrations and seeds default timings/roles/currency on first boot
- DB file: `salon.db` in project root (path overridable via `DB_PATH` env var)

**Cache Layer:**
- Purpose: Persistent JSON mirror of read-heavy DB tables; eliminates repeated DB reads for voice tool calls
- Location: `src/cache/salonDataCache.js`; file written to `data/salon-data.json`
- Exports: `initCache()`, `getCache()`, `patchCache(entityType, op, payload)`, `saveAtomic()`
- Entities cached: `deals`, `services`, `bookings`, `branches`, `staff`, `salonTimings`, `staffRoles`, `appSettings`
- Write safety: atomic write via `.tmp` + rename; serialised through `_writeQueue` promise chain
- Usage pattern: all DB mutations in `src/index.js` call `patchCache(...).catch(...)` fire-and-forget after the synchronous DB write succeeds

**Voice Call Server:**
- Purpose: Bridge browser microphone audio to Gemini Live Audio API via WebSocket
- Location: `src/server/apiCallLive.js`
- Exports: `setupCallServer(httpServer)`
- Transport: WebSocket at `/api/call` (upgraded from the HTTP server)
- Per-connection: one `GoogleGenAI` `live.connect()` session with a unique `callSessionId`
- Data flow in: browser AudioWorklet → PCM16 16kHz → `ws.send(binary)` → `session.sendRealtimeInput()`
- Data flow out: Gemini audio → PCM16 24kHz → `ws.send(binary)` → browser playback queue
- Tool calls: Gemini `toolCall` messages → `handleVoiceTool(name, args)` → cache with DB fallback → `session.sendToolResponse()`
- Origin validation: checks `WIDGET_ALLOWED_ORIGINS` env var on WebSocket upgrade

**Outbound Message Sender:**
- Purpose: Send chatbot replies back to the originating Meta platform
- Location: `src/utils/metaSender.js`
- Exports: `send(platform, recipientId, text, opts)`
- WhatsApp: `POST https://graph.facebook.com/v19.0/{phoneNumberId}/messages` with `WA_ACCESS_TOKEN`
- Instagram/Facebook: `POST https://graph.facebook.com/v19.0/me/messages` with `IG_PAGE_ACCESS_TOKEN` or `FB_PAGE_ACCESS_TOKEN`

## Request Flows

### Text Chat — Meta Webhook

```
POST /webhook
  → req.body.object detection in src/index.js
  → handleWhatsApp / handleInstagram / handleFacebook  (src/handlers/)
      → res.sendStatus(200)                            [immediate, before async work]
      → routeMessage(userId, text, platform)           (src/core/router.js)
          → detectIntent(text)                         (src/core/intent.js → Claude Haiku API)
          → reply generator                            (src/replies/)
              → getDb()                                (src/db/database.js → salon.db)
          → returns reply string
      → send(platform, userId, reply)                  (src/utils/metaSender.js → Meta Graph API)
```

### Text Chat — Web Widget

```
POST /api/chat  { message, sessionId }
  → routeMessage(sessionId, message, 'webchat')  (src/core/router.js)
      → detectIntent → reply generator → getDb()
  → res.json({ reply })
```

### Booking State Machine (within routeMessage)

```
routeMessage detects BOOKING intent or active ASK_* session state
  → handleBookingStep(userId, text, session, platform)  (src/replies/booking.js)
      → getSession / setSession                          (src/core/session.js)
      → getDb() for services, branches, staff queries
      → 7 states:
          ASK_NAME → ASK_PHONE → ASK_SERVICE → ASK_BRANCH
          → ASK_STAFF (optional if staff exist) → ASK_DATE → ASK_TIME
      → final state: saveBooking() → INSERT INTO bookings (source = platform)
      → clearSession(userId)
```

### Voice Call

```
Browser: user clicks 📞 (public/widget.js startVoiceCallModal)
  → new WebSocket(baseUrl + '/api/call')
  → src/server/apiCallLive.js: server.on('upgrade')
      → origin validation against WIDGET_ALLOWED_ORIGINS
      → wss.handleUpgrade → wss.emit('connection')
          → client.live.connect()  (@google/genai → Gemini 2.5 Flash Native Audio)
  → ws.onopen: ws.send({ type: 'greet' }) → Gemini greets caller
  → AudioWorklet downsamples mic to PCM16 16kHz → ws.send(binary)
      → session.sendRealtimeInput() → Gemini processes audio
  → Gemini response audio (PCM16 24kHz) → ws.send(binary) → browser playback queue
  → Gemini toolCall → handleVoiceTool(name, args)
      → reads from getCache() with getDb() fallback
      → for create_booking: INSERT INTO bookings + patchCache()
      → session.sendToolResponse({ functionResponses })
```

### Admin Panel CRUD

```
GET /admin  → requireAdminAuth  → src/admin/views/panel.html (static file)

GET/POST/PUT/DELETE /admin/api/*
  → requireAdminAuth
  → validateBookingBody() / checkBookingTiming() / checkStaffBranch()  (src/index.js helpers)
  → getDb() synchronous query / mutation  (better-sqlite3)
  → patchCache(entity, op, payload).catch(logger.error)  [fire-and-forget after DB write]
  → res.json({ ok: true } | { ok: false, error } | row object)
```

## Booking Flow Detail (7-Step State Machine)

State is stored in `src/core/session.js` under `session.state`. Each step is a `if (session.state === 'ASK_X')` branch in `handleBookingStep()`:

| Step | State | Collects | Key validation |
|------|-------|----------|----------------|
| start | none | — | services exist in DB |
| 2 | `ASK_NAME` | `name` | `isValidName()` — Latin/Urdu letters 2–60 chars; `extractName()` strips Urdu phrases |
| 3 | `ASK_PHONE` | `phone` | `isValidPhone()` — 7–15 digits; `extractPhone()` strips lead-ins |
| 4 | `ASK_SERVICE` | `service` | match by number index or partial name against `services` table |
| 5 | `ASK_BRANCH` | `branch` | match by number or partial name against `branches` table |
| 5b | `ASK_STAFF` | `staffId`, `staffName` | optional; `getActiveStaff(branchName)` filters by branch; "skip"/"any" accepted |
| 6 | `ASK_DATE` | `date` (ISO YYYY-MM-DD) | `isValidDate()` rejects past dates; `extractDate()` handles "kal"/"aaj"/"parson"; `normalizeDateToISO()` |
| 7 | `ASK_TIME` | `time` (HH:MM 24h) | `isValidTime()` + `getSalonTiming()` window check; `parseTimeTo24h()` normalizes am/pm/baje |
| save | — | — | `saveBooking()` → INSERT; `clearSession(userId)` |

Time validation error messages branch on `session.platform`:
- `whatsapp`: `*bold*` + emoji markdown with 🕐 prefix
- `instagram` / `facebook`: plain text, no markdown
- `webchat` / `voice`: concise slot range string

## Booking Validation (Admin Path)

Three helper functions defined in `src/index.js` applied to both `POST /admin/api/bookings` and `PUT /admin/api/bookings/:id`:

- `validateBookingBody(body)`: checks 7 required fields; rejects past dates via ISO string lexicographic compare
- `checkBookingTiming(date, time, db)`: reads `salon_timings` for `workday`/`weekend` by day-of-week; rejects times outside open/close window; returns `null` (skip) if no timing row configured
- `checkStaffBranch(staff_id, branch, db)`: staff optional; if provided, verifies `staff.branch_id` matches the booking branch or is `null` (unassigned staff)

## Key Design Decisions

**Synchronous DB throughout:** `better-sqlite3` is sync. All DB reads/writes block the event loop. Intentional — simplicity over throughput for a single-salon, low-concurrency use case.

**`platform` threaded through reply layer:** Every `routeMessage()` call passes `platform`. The booking state machine stores it in the session on the first step and reads it in `ASK_TIME` for format-appropriate error messages.

**Cache as read-through for voice:** `handleVoiceTool()` in `src/server/apiCallLive.js` reads `getCache()` first and falls back to `getDb()` only when cache is cold. This keeps voice tool calls off the SQLite synchronous path during real-time audio.

**No shared session state between text and voice:** Text chatbot uses `src/core/session.js` Map. Voice calls create an isolated Gemini session per WebSocket connection; the Gemini model manages the conversation. Both write to the same `bookings` table (voice with `source = 'voice'`, chatbot with `source = platform`).

**Fire-and-forget cache patching:** `patchCache()` is never `await`-ed in route handlers. The HTTP response is sent immediately after the synchronous DB write; the cache flush is background.

## Error Handling Strategy

**Webhook handlers (`src/handlers/`):** Try/catch per handler; errors logged via `logger.error()`. 200 already sent to Meta so no retry is triggered.

**Intent classifier (`src/core/intent.js`):** Catches API errors; falls back to `'UNKNOWN'` so the chatbot continues with a fallback message.

**Booking state machine (`src/replies/booking.js`):** `saveBooking()` wrapped in try/catch; on error clears session and returns a user-visible error string.

**Admin routes (`src/index.js`):** Validation errors return HTTP 400 `{ ok: false, error: string }`. Unexpected DB errors caught and returned as `{ ok: false, error: err.message }`.

**Voice WebSocket (`src/server/apiCallLive.js`):** Top-level try/catch per connection; failed `client.live.connect()` closes WebSocket with code 1011.

**Cache (`src/cache/salonDataCache.js`):** `initCache()` degrades to empty structure on failure so server still starts. `patchCache()` errors are logged and swallowed — they never propagate to callers.

## Cross-Cutting Concerns

**Logging:** `src/utils/logger.js` provides `logger.info()`, `logger.warn()`, `logger.error()` with ISO timestamp prefix. Some modules (`src/core/intent.js`, `src/replies/booking.js`, `src/server/apiCallLive.js`) use `console.log`/`console.error` directly.

**Auth:** Cookie-based admin auth only via `requireAdminAuth`. No auth on webhook routes (Meta verifies ownership via `hub.verify_token` at webhook setup time). No user auth on chatbot paths.

**CORS:** `/widget.js` and `/api/chat` carry explicit `Access-Control-Allow-Origin` headers (configurable via `WIDGET_ALLOWED_ORIGINS`). WebSocket upgrade checks origin against same env var. `/salon-data.json` is protected by a secret key query param, not CORS.

---

*Architecture analysis: 2026-04-02*
