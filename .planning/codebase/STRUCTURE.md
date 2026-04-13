# Codebase Structure

**Analysis Date:** 2026-04-02

## Directory Layout

```
salon-bot/                      # Project root
├── src/                        # All server-side Node.js code
│   ├── index.js                # Express app, all routes, server startup
│   ├── admin/
│   │   ├── auth.js             # requireAdminAuth middleware
│   │   └── views/
│   │       └── panel.html      # Admin SPA (single HTML file, vanilla JS)
│   ├── cache/
│   │   └── salonDataCache.js   # Persistent JSON cache: initCache, getCache, patchCache
│   ├── core/
│   │   ├── intent.js           # Claude Haiku intent classification
│   │   ├── router.js           # routeMessage() — intent → reply dispatcher
│   │   └── session.js          # In-memory booking session store (Map, TTL 10 min)
│   ├── db/
│   │   ├── database.js         # SQLite singleton (getDb), schema init, settings cache
│   │   └── seed.js             # Dev seed: deals, services, conditional staff/currency
│   ├── handlers/
│   │   ├── facebook.js         # Facebook Messenger webhook payload parser
│   │   ├── instagram.js        # Instagram webhook payload parser
│   │   └── whatsapp.js         # WhatsApp webhook payload parser
│   ├── replies/
│   │   ├── booking.js          # 7-step booking state machine
│   │   ├── branches.js         # Branch info reply generator
│   │   ├── deals.js            # Deals reply generator
│   │   └── prices.js           # Service list / price / detail reply generators
│   ├── server/
│   │   └── apiCallLive.js      # WebSocket voice call server (Gemini Live), handleVoiceTool
│   └── utils/
│       ├── logger.js           # Timestamped console wrapper (info/warn/error)
│       └── metaSender.js       # Meta Graph API message sender (WA/IG/FB)
├── public/                     # Static files served by Express
│   ├── admin/
│   │   ├── panel.css           # Admin panel styles
│   │   └── panel.js            # Admin panel JS (tabs, modals, all API fetch calls)
│   ├── demo.html               # Standalone demo page embedding the widget
│   └── widget.js               # Self-contained embeddable web chat + voice call widget
├── data/
│   └── salon-data.json         # Auto-generated persistent cache (never edit manually)
├── wp-plugin/
│   ├── salon-bot-widget.php    # WordPress plugin that injects widget.js
│   └── widget.js               # Copy of widget for WP plugin distribution
├── refrence_code_for_call/     # Reference TypeScript (not in production build)
│   ├── audioUtils.tsx
│   ├── liveAudioService.tsx
│   ├── liveService.tsx
│   └── VoiceCall.tsx
├── salon.db                    # SQLite database (never edit manually)
├── salon.db-shm                # SQLite WAL shared memory (auto-managed)
├── salon.db-wal                # SQLite WAL log (auto-managed)
├── package.json
├── package-lock.json
├── .nvmrc                      # Node version pin
├── .env.example                # Template for required environment variables
├── .env                        # Secrets (never commit)
├── CLAUDE.md                   # Developer notes and changelog
└── README.md
```

## Directory Purposes

**`src/` — Server-side application code:**
- All production Node.js lives here
- `src/index.js` is the single entry point and route registry
- Subdirectories map cleanly to functional layers (handlers, core, replies, db, cache, server, utils)

**`src/admin/` — Admin authentication and UI:**
- `auth.js`: single-function middleware `requireAdminAuth`. Checks `adminToken` cookie or `x-admin-token` header against `ADMIN_SESSION_SECRET`
- `views/panel.html`: full admin SPA. References `public/admin/panel.js` and `public/admin/panel.css` for styles/logic

**`src/cache/` — JSON persistence cache:**
- `salonDataCache.js` provides `initCache()`, `getCache()`, `patchCache(entityType, op, payload)`, `saveAtomic()`
- Writes atomically to `data/salon-data.json` via `.tmp` + rename
- Used by `src/server/apiCallLive.js` (voice tool reads) and `src/index.js` (patched after every DB mutation)

**`src/core/` — Message routing brain:**
- `router.js`: `routeMessage(userId, text, platform)` — the single function every inbound message channel calls
- `intent.js`: one async function `detectIntent(text)` calling Claude Haiku; returns intent string or `{ intent, term }`
- `session.js`: in-memory `Map` with TTL management; `setSession` merges data, `getSession` checks TTL, `clearSession` deletes

**`src/db/` — Database:**
- `database.js`: `getDb()` lazy-initializes a `better-sqlite3` instance, calls `initSchema()`, enables WAL mode. Also exports `getSettings()` (memoized `app_settings` rows) and `invalidateSettingsCache()`
- `seed.js`: exported as a function; destructively seeds deals and services; conditionally seeds currency and staff; triggered via `GET /run-seed?key=adminkey123`

**`src/handlers/` — Inbound webhook parsers:**
- Each file exports a `handle*` function and a `verify*` function (legacy; verification is now handled centrally in `src/index.js`)
- All three call `routeMessage()` then `send()` — identical pattern, different payload shapes:
  - WhatsApp: `value.messages[0]`, sender = `message.from`, requires `phoneNumberId` for reply
  - Instagram: `entry.messaging[0]`, sender = `messaging.sender.id`, skips echoes
  - Facebook: same shape as Instagram

**`src/replies/` — Reply generators:**
- Each module reads from `getDb()` synchronously and returns a formatted string
- `booking.js` is the most complex: 7 `if (session.state === 'ASK_X')` branches; local helper functions for extraction and validation (`extractName`, `isValidPhone`, `normalizeDateToISO`, `parseTimeTo24h`, etc.)
- Other modules (`prices.js`, `deals.js`, `branches.js`) are stateless read-only functions

**`src/server/` — Voice call WebSocket server:**
- `apiCallLive.js` exports `setupCallServer(httpServer)`
- `handleVoiceTool(name, args)` handles: `get_services`, `get_branches`, `get_timings`, `get_staff`, `create_booking`
- Voice bookings are inserted with `source = 'voice'`

**`src/utils/` — Shared utilities:**
- `logger.js`: simple object with `info/warn/error` methods, ISO timestamp prefix
- `metaSender.js`: `send(platform, recipientId, text, opts)` dispatcher; delegates to `sendWhatsApp` or `sendInstagramOrFacebook`

**`public/` — Static assets served at root:**
- `widget.js`: self-contained IIFE, no build step. Reads `data-bot-name` and `data-primary-color` from the script tag. Manages both text chat (`POST /api/chat`) and voice call (WebSocket `/api/call`)
- `admin/panel.js`: all admin tab logic, modal management, API fetch calls, `esc()` XSS helper, `setPhonePlaceholder()`, real-time time validation via `validateTimeInput()`
- `admin/panel.css`: admin panel styles, `.field-error` class for inline validation messages

**`data/` — Generated runtime data:**
- `salon-data.json`: auto-created by `initCache()` on first server start; rebuilt from DB if missing or corrupt. Protected by `SALON_DATA_KEY` env var at `GET /salon-data.json`
- Do not commit; not manually editable

**`wp-plugin/` — WordPress integration:**
- `salon-bot-widget.php`: WordPress plugin file that enqueues `widget.js` and injects scoped `<style>` to fix emoji sizing inside the widget
- `widget.js`: copy of the widget for standalone WP distribution
- Communicates with the same Express server over `/api/chat` and WebSocket `/api/call`

## Key File Locations

**Entry Points:**
- `src/index.js`: HTTP + WebSocket server startup; all routes

**Configuration:**
- `.env`: all secrets and runtime config (never commit)
- `.env.example`: template listing all required env vars including `GEMINI_API_KEY`, `SALON_DATA_KEY`, `ANTHROPIC_API_KEY`, `WIDGET_ALLOWED_ORIGINS`, `ADMIN_PASSWORD`, `ADMIN_SESSION_SECRET`, `META_VERIFY_TOKEN`, `WA_ACCESS_TOKEN`, `IG_PAGE_ACCESS_TOKEN`, `FB_PAGE_ACCESS_TOKEN`
- `.nvmrc`: Node version pin

**Core Logic:**
- `src/core/router.js`: central dispatch for all text messages
- `src/replies/booking.js`: entire booking conversation logic
- `src/server/apiCallLive.js`: voice call bridge and tool implementations

**Database:**
- `src/db/database.js`: schema, `getDb()` singleton
- `src/db/seed.js`: dev data

**Admin UI:**
- `src/admin/views/panel.html`: HTML shell
- `public/admin/panel.js`: all admin JavaScript
- `public/admin/panel.css`: all admin styles

**Widget:**
- `public/widget.js`: embeddable chat + voice widget

## Naming Conventions

**Files:**
- `camelCase.js` for all source files (e.g. `salonDataCache.js`, `metaSender.js`, `apiCallLive.js`)
- `panel.html`, `panel.js`, `panel.css` for admin UI
- `widget.js` for the embeddable widget

**Functions:**
- `camelCase` throughout (e.g. `routeMessage`, `handleBookingStep`, `getPricesReply`)
- Handler functions follow `handle{Platform}` / `verify{Platform}` pattern
- Reply generators follow `get{Topic}Reply` pattern
- Admin UI state variables follow `all{Entity}` pattern (e.g. `allBranches`, `allStaff`, `allRoles`)

**DB tables:**
- `snake_case` (e.g. `salon_timings`, `staff_roles`, `app_settings`)

## Where to Add New Code

**New chatbot intent / reply type:**
1. Add the intent string to the classifier prompt in `src/core/intent.js`
2. Add a case to the `switch(intent)` in `src/core/router.js`
3. Create a new reply module in `src/replies/{topic}.js` following the `getDb()` + plain string return pattern
4. Import and wire in `src/core/router.js`

**New admin API route:**
- Add to `src/index.js` after the relevant existing group (bookings, branches, staff, timings, roles)
- Apply `requireAdminAuth` middleware
- Use `validateBookingBody` / `checkBookingTiming` helpers if booking-related
- Add `patchCache(...).catch(logger.error)` after every DB mutation

**New voice tool:**
- Add a `functionDeclaration` to the `tools` array in `src/server/apiCallLive.js` `client.live.connect()` config
- Add a corresponding `if (name === 'tool_name')` branch in `handleVoiceTool()`
- Prefer `getCache()` with `getDb()` fallback for reads

**New admin UI tab:**
- HTML tab button and content section go in `src/admin/views/panel.html`
- Tab JS (fetch calls, modal logic, render functions) goes in `public/admin/panel.js`
- Follow the existing tab switch pattern with `data-tab` attributes

**New utility:**
- Shared server-side utilities go in `src/utils/`
- No client-side utility files — widget JS is inline in `public/widget.js`; admin JS is in `public/admin/panel.js`

**New widget feature:**
- All widget code is inline in `public/widget.js` (single IIFE, no build step)
- Mirror any significant changes to `wp-plugin/widget.js`

## Special Directories / Files

**`data/salon-data.json`:**
- Purpose: Persistent read-through cache for all salon reference data
- Generated: Yes (auto-created by `initCache()` on server start)
- Committed: Should not be committed (it reflects live DB state)

**`refrence_code_for_call/`:**
- Purpose: TypeScript reference implementations consulted during voice call development
- Generated: No
- Committed: Yes (as reference material)
- Not imported anywhere; has no effect on production

**`salon.db`, `salon.db-shm`, `salon.db-wal`:**
- Purpose: SQLite database and WAL mode files
- Generated: Yes (auto-created by `getDb()` on first call)
- Committed: No (in `.gitignore`)
- Never edit manually

---

*Structure analysis: 2026-04-02*
