# External Integrations

**Analysis Date:** 2026-04-02

## APIs & External Services

**AI / NLP:**
- Anthropic Claude Haiku — intent classification for all chatbot messages (WhatsApp, Instagram, Facebook, web widget)
  - SDK: `@anthropic-ai/sdk` ^0.39.0
  - Implementation: `src/core/intent.js` → `detectIntent(message)`
  - Model: `claude-haiku-4-5-20251001`
  - Auth env var: `ANTHROPIC_API_KEY`
  - Call: `client.messages.create({ model, max_tokens: 20, system, messages })`
  - Returns one of: `PRICE`, `DEALS`, `BOOKING`, `BRANCH`, `SERVICE_LIST`, `SERVICE_DETAIL|<term>`, `CANCEL`, `UNKNOWN`

- Google Gemini Live Audio — real-time voice call AI receptionist
  - SDK: `@google/genai` ^1.47.0
  - Implementation: `src/server/apiCallLive.js` → `setupCallServer(server)`
  - Model: `gemini-2.5-flash-native-audio-preview-12-2025`
  - Auth env var: `GEMINI_API_KEY`
  - Transport: WebSocket at `/api/call`; browser sends PCM16 at 16kHz, receives PCM audio at 24kHz
  - Tool calls handled server-side in `handleVoiceTool(name, args)`: `get_services`, `get_branches`, `get_timings`, `get_staff`, `create_booking`
  - Origin validation: checks `WIDGET_ALLOWED_ORIGINS` before upgrading WebSocket connection

**Meta Platforms:**
- Meta Graph API v19.0 — outbound message delivery for all three social platforms
  - Client: `axios` in `src/utils/metaSender.js` → `send(platform, recipientId, text, opts)`
  - Base URL: `https://graph.facebook.com/v19.0`
  - WhatsApp: `POST /{WA_PHONE_NUMBER_ID}/messages`; auth header `Bearer ${WA_ACCESS_TOKEN}`
  - Instagram: `POST /me/messages`; auth header `Bearer ${IG_PAGE_ACCESS_TOKEN}`
  - Facebook Messenger: `POST /me/messages`; auth header `Bearer ${FB_PAGE_ACCESS_TOKEN}`

## Data Storage

**Databases:**
- SQLite (local file)
  - File: `salon.db` at project root (configurable via `DB_PATH` env var)
  - Client: `better-sqlite3` ^9.4.3; synchronous API
  - Singleton: `src/db/database.js` → `getDb()`
  - WAL mode enabled; sidecars `salon.db-shm`, `salon.db-wal` present in production

**File Storage:**
- Local filesystem only
  - JSON cache: `data/salon-data.json` — written atomically via `src/cache/salonDataCache.js`
  - No cloud object storage (no S3, no GCS, no Azure Blob)

**Caching:**
- In-process memory + local JSON file
  - In-memory: `_cache` object in `src/cache/salonDataCache.js`
  - Persistent: `data/salon-data.json` (atomic write, survives restarts)
  - Settings cache: `_settingsCache` in `src/db/database.js`; invalidated via `invalidateSettingsCache()`

## Authentication & Identity

**Admin Panel:**
- Custom password + cookie session; no third-party auth provider
- Implementation: `src/admin/auth.js` → `requireAdminAuth(req, res, next)`
- Login: `POST /admin/login` — compares `req.body.password` against `ADMIN_PASSWORD` env var
- Session: `Set-Cookie: adminToken=<ADMIN_SESSION_SECRET>; HttpOnly; Path=/; Max-Age=86400; SameSite=Strict`
- Auth check: reads cookie `adminToken` or header `x-admin-token`; compares to `ADMIN_SESSION_SECRET`
- Logout: `GET /admin/logout` — clears cookie with `Max-Age=0`
- Required env vars: `ADMIN_PASSWORD`, `ADMIN_SESSION_SECRET`

**Meta Webhook:**
- Verification token: `GET /webhook?hub.verify_token=...` — compared against `META_VERIFY_TOKEN` env var
- No per-request signature validation detected (no `X-Hub-Signature-256` check)

## Webhooks

**Incoming (Meta → Server):**
- Endpoint: `POST /webhook`
- Handles all three Meta platforms on a single endpoint; dispatches by `req.body.object`:
  - `whatsapp_business_account` → `src/handlers/whatsapp.js` → `handleWhatsApp()`
  - `instagram` → `src/handlers/instagram.js` → `handleInstagram()`
  - `page` → `src/handlers/facebook.js` → `handleFacebook()`
- Verification: `GET /webhook` for Meta's hub challenge handshake

**Outgoing (Server → Meta):**
- All outbound messages via `src/utils/metaSender.js` → `send()`; fires after `routeMessage()` resolves

**WebSocket (Browser → Server):**
- Path: `/api/call` — browser opens WebSocket for Gemini Live Audio session
- Upgrade validated by origin check against `WIDGET_ALLOWED_ORIGINS`
- Binary frames: raw PCM16 mic audio at 16kHz
- JSON frames: control messages (e.g. `{ type: 'greet' }`)
- Server sends binary audio back to browser; also sends `{ type: 'text' }` and `{ type: 'interrupted' }` JSON frames

## Chat Widget API

- `POST /api/chat` — web widget text chat
  - Body: `{ message: string, sessionId: string }`
  - Response: `{ reply: string }`
  - CORS: controlled by `WIDGET_ALLOWED_ORIGINS` env var (default `*`)
  - Routes through same `routeMessage()` path as social platforms

## Data Cache Endpoint

- `GET /salon-data.json?key=<SALON_DATA_KEY>` — returns full JSON cache
  - Auth: query param `key` compared against `SALON_DATA_KEY` env var (fallback dev key: `adminkey123`)
  - Returns `401` for wrong/missing key; `503` if cache not yet warm
  - Intended for external integrations that need bulk read of salon data

## Seed / Maintenance Endpoint

- `GET /run-seed?key=adminkey123` — re-seeds deals, services, optionally staff and currency
  - Auth: hardcoded key `adminkey123`; not configurable via env

## WordPress Integration

- Plugin: `wp-plugin/salon-bot-widget.php` (standalone, PHP)
- Injects `<script src="{server_url}/widget.js">` in `wp_footer`
- Configures widget via `window.SalonBotConfig = { apiUrl, botName, primaryColor }`
- Admin settings page at WP Admin → Settings → Salon Bot Widget
- No server-side changes required for WordPress integration

## Environment Variables Reference

| Variable | Required | Purpose |
|---|---|---|
| `PORT` | No (default: 3000) | HTTP server port |
| `META_VERIFY_TOKEN` | Yes | Meta webhook hub verification |
| `WA_ACCESS_TOKEN` | Yes | WhatsApp Cloud API bearer token |
| `WA_PHONE_NUMBER_ID` | Yes | WhatsApp Phone Number ID for sending |
| `IG_PAGE_ACCESS_TOKEN` | Yes | Instagram Page Access Token |
| `FB_PAGE_ACCESS_TOKEN` | Yes | Facebook Page Access Token |
| `ANTHROPIC_API_KEY` | Yes | Claude Haiku intent classification |
| `GEMINI_API_KEY` | Yes | Gemini Live Audio voice calls |
| `ADMIN_PASSWORD` | Yes | Admin panel login password |
| `ADMIN_SESSION_SECRET` | Yes | Admin session cookie value (random hex) |
| `SALON_DATA_KEY` | No (default: adminkey123) | Key for `GET /salon-data.json` |
| `WIDGET_ALLOWED_ORIGINS` | No (default: *) | CORS allowed origins for `/api/chat` and `/api/call` |
| `DB_PATH` | No | Override SQLite file location |
| `BRANCH1_NAME` | No | Branch 1 name seeded on first boot |
| `BRANCH1_ADDRESS` | No | Branch 1 address |
| `BRANCH1_PHONE` | No | Branch 1 phone |
| `BRANCH1_MAP_LINK` | No | Branch 1 Google Maps URL |
| `BRANCH2_NAME` | No | Branch 2 name seeded on first boot |
| `BRANCH2_ADDRESS` | No | Branch 2 address |
| `BRANCH2_PHONE` | No | Branch 2 phone |
| `BRANCH2_MAP_LINK` | No | Branch 2 Google Maps URL |

## Monitoring & Observability

**Error Tracking:**
- Not detected — no Sentry, Datadog, or similar

**Logs:**
- Custom timestamped logger: `src/utils/logger.js`; wraps `console.log`/`console.error` with ISO timestamps
- Use `logger.info()` and `logger.error()` throughout server code (never `console.log` directly in production paths)
- Voice call handlers use `console.log`/`console.error` directly (inconsistency in `src/server/apiCallLive.js`)

## CI/CD & Deployment

**Hosting:**
- Not detected — no platform config (no Heroku Procfile, no Railway config, no render.yaml, no Vercel config)

**CI Pipeline:**
- Not detected — no GitHub Actions, no CircleCI config

---

*Integration audit: 2026-04-02*
