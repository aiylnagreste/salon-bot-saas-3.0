# Technology Stack

**Analysis Date:** 2026-04-02

## Languages

**Primary:**
- JavaScript (ES2020+) — all server-side and client-side code; no TypeScript
- PHP — WordPress plugin only (`wp-plugin/salon-bot-widget.php`)

**Secondary:**
- SQL — embedded synchronous SQLite queries throughout `src/index.js`, `src/server/apiCallLive.js`, `src/cache/salonDataCache.js`, `src/db/database.js`

## Runtime

**Environment:**
- Node.js >=18.0.0 (enforced via `engines` field in `package.json`)

**Package Manager:**
- npm
- Lockfile: `package-lock.json` present (lockfileVersion 3)

## Frameworks

**Core:**
- Express ^4.19.2 — HTTP server; all routes registered directly on `app` in `src/index.js`; no sub-routers
- `ws` ^8.20.0 — `WebSocketServer` for Gemini Live Audio voice call endpoint at `/api/call`; set up in `src/server/apiCallLive.js` via `setupCallServer(server)`

**Build/Dev:**
- nodemon ^3.1.0 (devDependency) — `npm run dev` restarts server on file changes

**Testing:**
- Not detected — no test framework in `package.json`, no test files present

## Key Dependencies

**AI / ML:**
- `@anthropic-ai/sdk` ^0.39.0 — Claude Haiku intent classification; `src/core/intent.js`; model `claude-haiku-4-5-20251001`
- `@google/genai` ^1.47.0 — Gemini Live Audio for real-time voice calls; `src/server/apiCallLive.js`; model `gemini-2.5-flash-native-audio-preview-12-2025`
- `@google/generative-ai` ^0.24.1 — older Gemini SDK; present as dependency but not used in active server code (legacy/reserved)

**Database:**
- `better-sqlite3` ^9.4.3 — synchronous SQLite driver; singleton via `src/db/database.js` → `getDb()`; all DB calls are blocking by design

**HTTP / Networking:**
- `axios` ^1.7.2 — outbound HTTP for Meta Graph API calls in `src/utils/metaSender.js`
- `express` ^4.19.2 — core HTTP framework
- `ws` ^8.20.0 — WebSocket server for real-time PCM audio streaming

**Config:**
- `dotenv` ^16.4.5 — loads `.env` into `process.env`; called at top of `src/index.js`

## Configuration

**Environment:**
- All config via `.env` at project root; `.env.example` documents all keys
- No config files other than `.env` (no YAML, no JSON config)

**Build:**
- No build step; plain Node.js — `node src/index.js` runs directly
- `npm start` → `node src/index.js`
- `npm run dev` → `nodemon src/index.js`
- `npm run seed` → `node src/db/seed.js`

## Data Layer

**Database:**
- SQLite via `better-sqlite3`; WAL journal mode (`PRAGMA journal_mode = WAL`) enabled on connection
- File: `salon.db` (project root); configurable via `DB_PATH` env var
- Schema auto-initialized in `src/db/database.js` → `initSchema(db)` on first `getDb()` call
- Migrations run inline within `initSchema()` via `PRAGMA table_info` checks
- Tables: `deals`, `services`, `bookings`, `branches`, `staff`, `salon_timings`, `staff_roles`, `app_settings`
- All queries are synchronous; no Promises in DB layer

**Persistent JSON Cache:**
- File: `data/salon-data.json` (auto-created on first boot)
- Module: `src/cache/salonDataCache.js`; exports `initCache`, `getCache`, `patchCache`, `saveAtomic`
- Written atomically via `.tmp` + `fs.renameSync`; writes serialized through `_writeQueue` promise chain
- Incremental `patchCache(entity, 'upsert'|'delete'|'replace', payload)` used fire-and-forget after every DB mutation

## Server Architecture

- HTTP server: `http.createServer(app)` — required for WebSocket upgrade support
- WebSocket upgrade handled by `server.on('upgrade')` in `src/server/apiCallLive.js`
- Voice call sessions attach per-connection; each call gets a unique `callSessionId`
- Express app and WebSocket server share the same Node HTTP server instance

## Static Assets

- `public/` served via `express.static`
- `public/widget.js` — embeddable chat + voice widget (vanilla JS, no build step)
- `public/admin/panel.css`, `public/admin/panel.js` — admin UI (vanilla JS)
- Admin HTML: `src/admin/views/panel.html` (served via `res.sendFile`, not from public/)

## Platform Requirements

**Development:**
- Node.js >=18.0.0
- npm
- Writable filesystem at project root for `salon.db` and `data/`
- `.env` file with all required keys populated

**Production:**
- Node.js >=18.0.0 process (long-running)
- Writable filesystem for `salon.db`, `salon.db-shm`, `salon.db-wal`, `data/salon-data.json`
- HTTPS termination must be handled upstream (reverse proxy such as nginx or Caddy)
- No containerization config detected (no Dockerfile, no docker-compose)
- No process manager config detected (no PM2 config, no systemd unit)
- No cloud deployment config detected (no Procfile, no app.yaml, no render.yaml)

---

*Stack analysis: 2026-04-02*
