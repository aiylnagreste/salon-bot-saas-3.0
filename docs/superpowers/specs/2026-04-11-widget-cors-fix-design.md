# Widget CORS Fix — Design Spec
**Date:** 2026-04-11  
**Status:** Approved

---

## Problem

The chat widget (`widget.js`) uses `new URL(scriptEl.src).origin` as its `baseUrl`. When the widget script is served from Vercel (`https://frontend-nextjs-two-psi.vercel.app/widget/SA_01/widget.js`), all chat and voice call requests go to Vercel — but Vercel has no `/api/chat` route and no WebSocket support. The result:

- `POST https://vercel.app/api/chat` → blocked by CORS (no CORS headers on Vercel)
- `wss://vercel.app/api/call` → WebSocket connection fails

The Railway backend already has `Access-Control-Allow-Origin: *` on `/api/chat` and supports WebSocket for voice. Requests just need to go there directly.

---

## Approach

**C + Per-tenant URL validation**

- Widget reads a `data-backend-url` attribute and sends chat/call to Railway directly
- Each tenant registers their website URL in the admin settings
- Railway validates the request `Origin` header against the registered URL
- `PUBLIC_BACKEND_URL` env var on Railway lets the frontend auto-generate the correct embed code

---

## Section 1: Data Layer

**Storage:** `{t}_app_settings` key/value table (already exists per tenant; currency stored here).  
**New key:** `widget_url` — the tenant's website URL (e.g. `https://my-salon.com`)

**Extend existing endpoints:**

- `GET /salon-admin/api/settings/general`  
  Already spreads all `{t}_app_settings` rows — `widget_url` is returned automatically once stored. Only new addition: inject `backend_url` from `process.env.PUBLIC_BACKEND_URL` alongside the DB fields.

- `PUT /salon-admin/api/settings/general`  
  Accept optional `widget_url` field; upsert into `{t}_app_settings`. Note: the handler currently requires `currency` to be non-empty. The Widget tab must read current `currency` from `fetchGeneral()` and re-send it when saving `widget_url`.

No new tables or migrations required.

---

## Section 2: Backend CORS Logic

**Affected endpoints:** `OPTIONS /api/chat`, `POST /api/chat`, WebSocket `/api/call`

**Logic (same for all):**

```
origin = req.headers.origin
tenantId = req.body.tenantId || req.query.tenantId

widget_url = db lookup {tenantId}_app_settings WHERE key='widget_url'

if widget_url is set:
  if origin matches widget_url (origin-level match, not path):
    Access-Control-Allow-Origin: <origin>
  else:
    return 403 { error: "Origin not allowed" }
else:
  Access-Control-Allow-Origin: *   ← fallback so existing tenants aren't broken
```

**Origin matching:** Compare `new URL(widget_url).origin` against the `Origin` request header (exact string match — no wildcard subdomains).

**`/salon-config/:tenantId`** — public bootstrap endpoint, stays `Access-Control-Allow-Origin: *` unchanged.  
**`/api/availability/*`** — public slot-check endpoints, stays `*` unchanged.

---

## Section 3: widget.js — `data-backend-url`

Add attribute reading at the top of the IIFE, alongside existing `data-bot-name` and `data-primary-color`:

```js
var backendUrl = scriptEl.getAttribute('data-backend-url') || baseUrl;
```

Change two call sites:
- `fetch(baseUrl + '/api/chat', ...)` → `fetch(backendUrl + '/api/chat', ...)`
- WebSocket URL construction → use `backendUrl` instead of `baseUrl`

`baseUrl` (derived from `scriptEl.src`) stays unchanged for `salon-config` fetches — those are still proxied correctly through Vercel.

**Generated embed code format:**
```html
<script 
  src="https://vercel.app/widget/SA_01/widget.js"
  data-backend-url="https://railway.app"
  data-primary-color="#8b4a6b">
</script>
```

---

## Section 4: Frontend UI — Widget Tab

**Location:** `frontend/app/(dashboard)/settings/page.tsx` — add new tab `"widget"` alongside existing tabs.

**New component:** `frontend/components/settings/WidgetTab.tsx`

**Contents:**

1. **Website URL field**  
   Label: "Your Website URL"  
   Placeholder: `https://my-salon.com`  
   Saved via `PUT /salon-admin/api/settings/general` with `{ widget_url }`  
   Help text: "Requests from this origin will be allowed to use the chat widget"

2. **Embed Code Generator** (read-only, auto-populated)  
   Shows the `<script>` tag with:
   - `src` = `${window.location.origin}/widget/${tenantId}/widget.js`
   - `data-backend-url` = `backend_url` from `GET /salon-admin/api/settings/general`
   - `data-primary-color` = tenant's primary color (or default)  
   Copy button copies the full tag to clipboard.

3. **Info note**: "Paste this script tag into your website's HTML to embed the chat widget."

**Data flow:**
- On mount: `GET /salon-admin/api/settings/general` → populate `widget_url` input and `backend_url` for embed code
- On save: `PUT /salon-admin/api/settings/general` with `{ widget_url }`

---

## Environment Variables

| Var | Where | Purpose |
|-----|-------|---------|
| `PUBLIC_BACKEND_URL` | Railway | Returned by `/salon-admin/api/settings/general` so frontend can show correct `data-backend-url` in embed code |

---

## Error Handling

- If `PUBLIC_BACKEND_URL` is not set on Railway, `backend_url` is omitted from the general settings response; the embed code generator shows a placeholder `"YOUR_RAILWAY_URL"` with a warning.
- If tenant hasn't set `widget_url`, CORS falls back to `*` (no regression for existing deployments).
- Origin mismatch on a configured tenant → `403 { error: "Origin not allowed" }` on chat/call only; widget still loads (salon-config stays `*`).

---

## Files Changed

| File | Change |
|------|--------|
| `src/index.js` | Extend `GET/PUT /salon-admin/api/settings/general`; update CORS logic on `/api/chat` (OPTIONS + POST); update WebSocket origin check in `apiCallLive.js` |
| `src/server/apiCallLive.js` | Per-tenant origin check on WS upgrade |
| `public/widget.js` | Read `data-backend-url`; use `backendUrl` for chat + call |
| `public/demo.html` | No change needed (uses relative URL, already points to Railway when self-hosted) |
| `frontend/app/(dashboard)/settings/page.tsx` | Add "Widget" tab |
| `frontend/components/settings/WidgetTab.tsx` | New component |
| `frontend/lib/queries.ts` | Extend `fetchGeneral` return type to include `widget_url`, `backend_url` |
| `frontend/lib/types.ts` (if it exists) | Add fields to GeneralSettings type |
