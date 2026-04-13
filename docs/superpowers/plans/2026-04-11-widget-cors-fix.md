# Widget CORS Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix CORS/WebSocket failures when the widget is served from Vercel by routing chat and call directly to Railway via `data-backend-url`, and adding per-tenant origin validation.

**Architecture:** widget.js reads a new `data-backend-url` attribute and uses it (instead of its own script origin) for all `/api/chat` and `/api/call` traffic. The Railway backend validates each request's `Origin` header against a per-tenant `widget_url` stored in `app_settings`. The admin frontend's existing embed code generator is extended to include `data-backend-url` automatically.

**Tech Stack:** Node.js / Express (backend), better-sqlite3, JavaScript IIFE (widget), Next.js / React / TanStack Query (frontend)

---

## File Map

| File | Change |
|------|--------|
| `src/index.js` | Add `getTenantWidgetUrl()` + `resolveWidgetCorsOrigin()` helpers; extend `GET/PUT /salon-admin/api/settings/general`; update `/api/chat` CORS |
| `src/server/apiCallLive.js` | Replace `WIDGET_ALLOWED_ORIGINS` env-var check with per-tenant DB lookup |
| `public/widget.js` | Read `data-backend-url` attribute; use `backendUrl` for chat + call |
| `test/widget-cors.test.js` | New — unit tests for CORS helper logic |
| `frontend/lib/queries.ts` | Extend `fetchGeneral` return type with `widget_url` and `backend_url` |
| `frontend/app/(dashboard)/settings/page.tsx` | Add `widgetSiteUrl` state + input; extend embed code with `data-backend-url`; extend save mutation |

---

## Task 1: Backend helpers + general settings endpoints

**Files:**
- Modify: `src/index.js` (around lines 105–128 for CORS middleware, 1523–1559 for general settings)
- Create: `test/widget-cors.test.js`

### Step 1.1 — Write failing unit tests for the CORS helpers

Create `test/widget-cors.test.js`:

```js
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// Inline the helper logic so tests run without starting the server
function getTenantWidgetUrl(db, tenantId) {
  try {
    const row = db.prepare(`SELECT value FROM ${tenantId}_app_settings WHERE key = 'widget_url'`).get();
    return row?.value || null;
  } catch (_) {
    return null;
  }
}

function resolveWidgetCorsOrigin(widgetUrl, requestOrigin) {
  if (!widgetUrl) return '*';
  try {
    const allowedOrigin = new URL(widgetUrl).origin;
    return requestOrigin === allowedOrigin ? requestOrigin : null;
  } catch (_) {
    return '*';
  }
}

describe('resolveWidgetCorsOrigin', () => {
  test('returns * when no widget_url configured', () => {
    assert.equal(resolveWidgetCorsOrigin(null, 'https://attacker.com'), '*');
  });

  test('returns origin when it matches widget_url', () => {
    const result = resolveWidgetCorsOrigin('https://my-salon.com', 'https://my-salon.com');
    assert.equal(result, 'https://my-salon.com');
  });

  test('returns null when origin does not match widget_url', () => {
    const result = resolveWidgetCorsOrigin('https://my-salon.com', 'https://attacker.com');
    assert.equal(result, null);
  });

  test('ignores path — origin match is scheme+host+port only', () => {
    const result = resolveWidgetCorsOrigin('https://my-salon.com/some/path', 'https://my-salon.com');
    assert.equal(result, 'https://my-salon.com');
  });

  test('returns * for malformed widget_url', () => {
    const result = resolveWidgetCorsOrigin('not-a-url', 'https://anything.com');
    assert.equal(result, '*');
  });
});
```

- [ ] Create the file with the content above

### Step 1.2 — Run tests to verify they fail

```bash
cd "d:/vs self code/salon-bot"
node --test test/widget-cors.test.js
```

Expected: `resolveWidgetCorsOrigin` tests all fail with "resolveWidgetCorsOrigin is not defined" (the function is defined in the test file itself, so they should actually pass — this task validates the test logic is correct before touching production code).

Expected output: all 5 tests **PASS** (the helpers are self-contained in the test file).

- [ ] Run the command and confirm all 5 pass

### Step 1.3 — Add helpers to `src/index.js`

In `src/index.js`, add these two helpers directly after the `rateLimit` function (around line 73), before the `NO_SHOW_GRACE_MIN` line:

```js
// ─────────────────────────────────────────────────────────────────────────────
//  Widget CORS helpers
// ─────────────────────────────────────────────────────────────────────────────

// Returns the widget_url stored in app_settings for a tenant, or null.
function getTenantWidgetUrl(tenantId) {
  try {
    const row = getDb().prepare(
      `SELECT value FROM ${tenantId}_app_settings WHERE key = 'widget_url'`
    ).get();
    return row?.value || null;
  } catch (_) {
    return null;
  }
}

// Returns the CORS origin to echo, '*' if unconfigured, or null if blocked.
function resolveWidgetCorsOrigin(tenantId, requestOrigin) {
  const widgetUrl = getTenantWidgetUrl(tenantId);
  if (!widgetUrl) return '*';
  try {
    const allowedOrigin = new URL(widgetUrl).origin;
    return requestOrigin === allowedOrigin ? requestOrigin : null;
  } catch (_) {
    return '*'; // malformed widget_url → fail open
  }
}
```

- [ ] Add the helpers to `src/index.js`

### Step 1.4 — Extend `GET /salon-admin/api/settings/general`

Find the existing GET handler (line ~1523). Replace:

```js
app.get("/salon-admin/api/settings/general", requireTenantAuth, (req, res) => {
  const tenantId = req.tenantId;
  const cache = getCache(tenantId);
  const base = cache?.appSettings ?? (() => {
    const rows = getDb().prepare(`SELECT key, value FROM ${tenantId}_app_settings`).all();
    const result = {};
    rows.forEach((r) => { result[r.key] = r.value; });
    return result;
  })();
  const tenant = getTenantById(tenantId);
  res.json({ ...base, tenantId, owner_name: tenant?.owner_name ?? null });
});
```

With:

```js
app.get("/salon-admin/api/settings/general", requireTenantAuth, (req, res) => {
  const tenantId = req.tenantId;
  const cache = getCache(tenantId);
  const base = cache?.appSettings ?? (() => {
    const rows = getDb().prepare(`SELECT key, value FROM ${tenantId}_app_settings`).all();
    const result = {};
    rows.forEach((r) => { result[r.key] = r.value; });
    return result;
  })();
  const tenant = getTenantById(tenantId);
  const backend_url = process.env.PUBLIC_BACKEND_URL || null;
  res.json({
    ...base,
    tenantId,
    owner_name: tenant?.owner_name ?? null,
    ...(backend_url && { backend_url }),
  });
});
```

- [ ] Apply the change

### Step 1.5 — Extend `PUT /salon-admin/api/settings/general`

Find the existing PUT handler (line ~1536). Replace:

```js
app.put("/salon-admin/api/settings/general", requireTenantAuth, (req, res) => {
  const tenantId = req.tenantId;
  const { currency, bot_name, primary_color } = req.body;
  if (!currency?.trim())
    return res.status(400).json({ error: "Currency is required" });

  const db = getDb();
  const upsert = (key, value) => db.prepare(`
    INSERT INTO ${tenantId}_app_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, value);

  upsert('currency', currency.trim());
  if (bot_name !== undefined) upsert('bot_name', (bot_name || '').trim());
  if (primary_color !== undefined) upsert('primary_color', (primary_color || '#8b4a6b').trim());

  invalidateSettingsCache();
  patchCache(tenantId, "appSettings", "upsert", {
    currency: currency.trim(),
    ...(bot_name !== undefined && { bot_name: (bot_name || '').trim() }),
    ...(primary_color !== undefined && { primary_color: (primary_color || '#8b4a6b').trim() }),
  }).catch((e) => logger.error("[cache] appSettings patch:", e.message));
  res.json({ ok: true });
});
```

With:

```js
app.put("/salon-admin/api/settings/general", requireTenantAuth, (req, res) => {
  const tenantId = req.tenantId;
  const { currency, bot_name, primary_color, widget_url } = req.body;
  if (!currency?.trim())
    return res.status(400).json({ error: "Currency is required" });

  const db = getDb();
  const upsert = (key, value) => db.prepare(`
    INSERT INTO ${tenantId}_app_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, value);

  upsert('currency', currency.trim());
  if (bot_name !== undefined) upsert('bot_name', (bot_name || '').trim());
  if (primary_color !== undefined) upsert('primary_color', (primary_color || '#8b4a6b').trim());
  if (widget_url !== undefined) upsert('widget_url', (widget_url || '').trim());

  invalidateSettingsCache();
  patchCache(tenantId, "appSettings", "upsert", {
    currency: currency.trim(),
    ...(bot_name !== undefined && { bot_name: (bot_name || '').trim() }),
    ...(primary_color !== undefined && { primary_color: (primary_color || '#8b4a6b').trim() }),
    ...(widget_url !== undefined && { widget_url: (widget_url || '').trim() }),
  }).catch((e) => logger.error("[cache] appSettings patch:", e.message));
  res.json({ ok: true });
});
```

- [ ] Apply the change

### Step 1.6 — Commit

```bash
cd "d:/vs self code/salon-bot"
git add src/index.js test/widget-cors.test.js
git commit -m "feat: add widget CORS helpers and extend general settings with widget_url + backend_url"
```

- [ ] Commit

---

## Task 2: Per-tenant CORS on `/api/chat`

**Files:**
- Modify: `src/index.js` (around lines 478–508)

### Step 2.1 — Update OPTIONS and POST handlers for `/api/chat`

Find the existing OPTIONS + POST handlers (around line 478). Replace both:

```js
// CORS pre-flight for chat
app.options("/api/chat", (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.sendStatus(204);
});

app.post("/api/chat", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const { message, sessionId, tenantId } = req.body;
```

With:

```js
// CORS pre-flight for chat (body not available on OPTIONS, so allow * on preflight)
app.options("/api/chat", (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.sendStatus(204);
});

app.post("/api/chat", async (req, res) => {
  const { message, sessionId, tenantId } = req.body;
  if (!message || !sessionId)
    return res.status(400).json({ error: "message and sessionId required" });
  if (!tenantId)
    return res.status(400).json({ error: "tenantId required" });

  const requestOrigin = req.headers.origin || '';
  const corsOrigin = resolveWidgetCorsOrigin(tenantId, requestOrigin);
  if (corsOrigin === null)
    return res.status(403).json({ error: "Origin not allowed" });
  res.setHeader("Access-Control-Allow-Origin", corsOrigin);
```

Then remove the duplicate validation lines that currently follow `res.setHeader("Access-Control-Allow-Origin", "*")`:

```js
  // DELETE these lines — they are now above:
  // const { message, sessionId, tenantId } = req.body;
  // if (!message || !sessionId)
  //   return res.status(400).json({ error: "message and sessionId required" });
  // if (!tenantId)
  //   return res.status(400).json({ error: "tenantId required" });
```

The rest of the POST handler (rate limit, isTenantActive, routeMessage) stays unchanged.

- [ ] Apply the change

### Step 2.2 — Add CORS unit test for blocked origin

Add to `test/widget-cors.test.js`:

```js
describe('POST /api/chat origin blocking (conceptual)', () => {
  test('resolveWidgetCorsOrigin blocks mismatched origin', () => {
    // Simulates what the POST handler does
    const corsOrigin = resolveWidgetCorsOrigin('https://my-salon.com', 'https://evil.com');
    assert.equal(corsOrigin, null); // handler would return 403
  });

  test('resolveWidgetCorsOrigin allows matching origin', () => {
    const corsOrigin = resolveWidgetCorsOrigin('https://my-salon.com', 'https://my-salon.com');
    assert.equal(corsOrigin, 'https://my-salon.com');
  });
});
```

- [ ] Add the tests

### Step 2.3 — Run tests

```bash
cd "d:/vs self code/salon-bot"
node --test test/widget-cors.test.js
```

Expected: all 7 tests PASS

- [ ] Run and confirm

### Step 2.4 — Commit

```bash
cd "d:/vs self code/salon-bot"
git add src/index.js test/widget-cors.test.js
git commit -m "feat: per-tenant origin validation on POST /api/chat"
```

- [ ] Commit

---

## Task 3: Per-tenant origin check in WebSocket (`apiCallLive.js`)

**Files:**
- Modify: `src/server/apiCallLive.js` (around lines 243–252)

### Step 3.1 — Replace env-var origin check with DB lookup

Find the block (lines ~243–252):

```js
        const allowed = (process.env.WIDGET_ALLOWED_ORIGINS || '*')
            .split(',')
            .map(o => o.trim());
        const origin = req.headers.origin || '';

        if (!allowed.includes('*') && !allowed.includes(origin)) {
            socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
            socket.destroy();
            return;
        }
```

Replace with:

```js
        const origin = req.headers.origin || '';
        try {
            const db = getDb();
            const row = db.prepare(
                `SELECT value FROM ${tenantId}_app_settings WHERE key = 'widget_url'`
            ).get();
            const widgetUrl = row?.value;
            if (widgetUrl) {
                const allowedOrigin = new URL(widgetUrl).origin;
                if (origin !== allowedOrigin) {
                    socket.write('HTTP/1.1 403 Forbidden\r\n\r\nOrigin not allowed');
                    socket.destroy();
                    return;
                }
            }
            // If widget_url not configured → allow all origins (fallback)
        } catch (e) {
            console.error('[call] Origin check DB error:', e.message);
            // Fail open — allow the connection if DB lookup fails
        }
```

- [ ] Apply the change

### Step 3.2 — Commit

```bash
cd "d:/vs self code/salon-bot"
git add src/server/apiCallLive.js
git commit -m "feat: replace WIDGET_ALLOWED_ORIGINS env var with per-tenant DB lookup in WebSocket"
```

- [ ] Commit

---

## Task 4: `widget.js` — `data-backend-url` attribute

**Files:**
- Modify: `public/widget.js` (lines 7, 19–20, 271, 496)

### Step 4.1 — Read `data-backend-url` at the top of the IIFE

Find the existing attribute reads (around line 18–19):

```js
  var botName = scriptEl.getAttribute('data-bot-name') || 'Salon Assistant';
  var primaryColor = scriptEl.getAttribute('data-primary-color') || '#8b4a6b';
```

Add one line immediately after `primaryColor`:

```js
  var botName = scriptEl.getAttribute('data-bot-name') || 'Salon Assistant';
  var primaryColor = scriptEl.getAttribute('data-primary-color') || '#8b4a6b';
  var backendUrl = scriptEl.getAttribute('data-backend-url') || baseUrl;
```

- [ ] Apply the change

### Step 4.2 — Use `backendUrl` for WebSocket call

Find line ~271:

```js
    var wsUrl = baseUrl.replace('https', 'wss').replace('http', 'ws') + '/api/call?tenantId=' + encodeURIComponent(tenantId);
```

Replace with:

```js
    var wsUrl = backendUrl.replace('https', 'wss').replace('http', 'ws') + '/api/call?tenantId=' + encodeURIComponent(tenantId);
```

- [ ] Apply the change

### Step 4.3 — Use `backendUrl` for chat fetch

Find line ~496:

```js
    fetch(baseUrl + '/api/chat', {
```

Replace with:

```js
    fetch(backendUrl + '/api/chat', {
```

- [ ] Apply the change

### Step 4.4 — Verify `baseUrl` is still used for salon-config (no change needed)

Line 23 should still read:

```js
    fetch(baseUrl + '/salon-config/' + tenantId)
```

This is correct — salon-config is still proxied through Vercel. Confirm it is unchanged.

- [ ] Confirm line 23 still uses `baseUrl`

### Step 4.5 — Commit

```bash
cd "d:/vs self code/salon-bot"
git add public/widget.js
git commit -m "feat: widget reads data-backend-url for chat and call traffic"
```

- [ ] Commit

---

## Task 5: Frontend — extend `GeneralTab` with website URL + backend URL in embed code

**Files:**
- Modify: `frontend/lib/queries.ts` (line 69–70)
- Modify: `frontend/app/(dashboard)/settings/page.tsx` (GeneralTab component, lines ~96–560)

### Step 5.1 — Extend `fetchGeneral` return type in `queries.ts`

Find line ~69–70 in `frontend/lib/queries.ts`:

```ts
export const fetchGeneral = () =>
  api.get<{ currency: string; timezone?: string; tenantId?: string; owner_name?: string | null }>(`${BASE}/settings/general`);
```

Replace with:

```ts
export const fetchGeneral = () =>
  api.get<{ currency: string; timezone?: string; tenantId?: string; owner_name?: string | null; widget_url?: string; backend_url?: string }>(`${BASE}/settings/general`);
```

- [ ] Apply the change

### Step 5.2 — Add `widgetSiteUrl` and `backendUrl` state to `GeneralTab`

In `settings/page.tsx`, find the existing state declarations in `GeneralTab` (around line 104–107):

```tsx
  const [currency, setCurrency] = useState(general?.currency ?? "Rs.");
  const [botName, setBotName] = useState((general as Record<string, string> | undefined)?.bot_name ?? "");
  const [primaryColor, setPrimaryColor] = useState((general as Record<string, string> | undefined)?.primary_color ?? "#8b4a6b");
  const [copied, setCopied] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState(false);
```

Replace with:

```tsx
  const [currency, setCurrency] = useState(general?.currency ?? "Rs.");
  const [botName, setBotName] = useState((general as Record<string, string> | undefined)?.bot_name ?? "");
  const [primaryColor, setPrimaryColor] = useState((general as Record<string, string> | undefined)?.primary_color ?? "#8b4a6b");
  const [widgetSiteUrl, setWidgetSiteUrl] = useState((general as Record<string, string> | undefined)?.widget_url ?? "");
  const backendUrl = (general as Record<string, string> | undefined)?.backend_url ?? "";
  const [copied, setCopied] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState(false);
```

- [ ] Apply the change

### Step 5.3 — Sync `widgetSiteUrl` from general data in `useEffect`

Find the existing `useEffect` that syncs state (around line 111–117):

```tsx
  useEffect(() => {
    if (general?.currency) setCurrency(general.currency);
    const bn = (general as Record<string, string> | undefined)?.bot_name;
    if (bn) setBotName(bn);
    const pc = (general as Record<string, string> | undefined)?.primary_color;
    if (pc) setPrimaryColor(pc);
  }, [general]);
```

Replace with:

```tsx
  useEffect(() => {
    if (general?.currency) setCurrency(general.currency);
    const bn = (general as Record<string, string> | undefined)?.bot_name;
    if (bn) setBotName(bn);
    const pc = (general as Record<string, string> | undefined)?.primary_color;
    if (pc) setPrimaryColor(pc);
    const wu = (general as Record<string, string> | undefined)?.widget_url;
    if (wu !== undefined) setWidgetSiteUrl(wu);
  }, [general]);
```

- [ ] Apply the change

### Step 5.4 — Add `data-backend-url` to the embed script tag

Find the `scriptAttrs` array (around line 123–127):

```tsx
  const scriptAttrs = [
    `src="${widgetUrl}"`,
    botName.trim() ? `data-bot-name="${botName.trim()}"` : null,
    primaryColor !== "#8b4a6b" ? `data-primary-color="${primaryColor}"` : null,
  ].filter(Boolean).join("\n  ");
```

Replace with:

```tsx
  const scriptAttrs = [
    `src="${widgetUrl}"`,
    backendUrl ? `data-backend-url="${backendUrl}"` : null,
    botName.trim() ? `data-bot-name="${botName.trim()}"` : null,
    primaryColor !== "#8b4a6b" ? `data-primary-color="${primaryColor}"` : null,
  ].filter(Boolean).join("\n  ");
```

- [ ] Apply the change

### Step 5.5 — Add Website URL input to Widget Appearance card

Find the end of the Widget Appearance card, just before the "Save Widget Settings" button (around line 320–328):

```tsx
            <button 
              onClick={() => saveMutation.mutate()} 
              disabled={saveMutation.isPending} 
              style={primaryBtn}
            >
              {saveMutation.isPending ? "Saving…" : "Save Widget Settings"}
            </button>
```

Insert before that button:

```tsx
            <label style={{ fontSize: "12px", fontWeight: 500, display: "block", marginBottom: "4px", color: "var(--color-sub)", marginTop: "20px" }}>
              Allowed Website URL
            </label>
            <input
              type="url"
              value={widgetSiteUrl}
              onChange={(e) => setWidgetSiteUrl(e.target.value)}
              placeholder="https://my-salon.com"
              style={{
                width: "100%",
                padding: "9px 12px",
                border: "1px solid var(--color-border)",
                borderRadius: "8px",
                fontSize: "13px",
                background: "var(--color-surface)",
                marginBottom: "6px",
                boxSizing: "border-box",
              }}
            />
            <p style={{ fontSize: "11px", color: "var(--color-sub)", marginBottom: "16px" }}>
              Widget chat and voice calls are only accepted from this origin. Leave blank to allow all.
            </p>
```

- [ ] Apply the change

### Step 5.6 — Extend `saveMutation` to include `widget_url`

Find the `saveMutation` `mutationFn` (around line 144–150):

```tsx
  const saveMutation = useMutation({
    mutationFn: () =>
      api.put("/salon-admin/api/settings/general", {
        currency,
        bot_name: botName,
        primary_color: primaryColor,
      }),
```

Replace with:

```tsx
  const saveMutation = useMutation({
    mutationFn: () =>
      api.put("/salon-admin/api/settings/general", {
        currency,
        bot_name: botName,
        primary_color: primaryColor,
        widget_url: widgetSiteUrl,
      }),
```

- [ ] Apply the change

### Step 5.7 — Commit

```bash
cd "d:/vs self code/frontend"
git add lib/queries.ts app/(dashboard)/settings/page.tsx
git commit -m "feat: add widget_url input and data-backend-url to embed code in GeneralTab"
```

- [ ] Commit

---

## Task 6: Set `PUBLIC_BACKEND_URL` on Railway

### Step 6.1 — Add the environment variable on Railway

In your Railway project dashboard:

1. Go to **Variables** tab for the backend service
2. Add: `PUBLIC_BACKEND_URL` = `https://salon-bot-20-saas-production.up.railway.app`  
   (replace with your actual Railway URL if different)

- [ ] Add the env var on Railway

### Step 6.2 — Verify locally (optional)

To test locally, add to your `.env` file:

```
PUBLIC_BACKEND_URL=http://localhost:3000
```

Then `GET /salon-admin/api/settings/general` should return `{ ..., backend_url: "http://localhost:3000" }`.

- [ ] Verify the response includes `backend_url`

---

## Task 7: Smoke test end-to-end

### Step 7.1 — Manual test: widget from external site

1. In Railway settings admin panel → General tab → Widget Appearance
2. Set **Allowed Website URL** to `https://salon-bot-20-saas-production.up.railway.app` (the demo URL)
3. Save Settings
4. Copy the generated **Embed Script Tag** — it should now include `data-backend-url="https://salon-bot-20-saas-production.up.railway.app"`
5. Open `demo.html` and paste the script in the "Paste Script" tab
6. Verify: chat messages succeed (no CORS error in console)
7. Verify: voice call connects via WebSocket (`wss://railway.app/api/call?...`)

- [ ] Run the smoke test

### Step 7.2 — Verify origin blocking works

1. Change the **Allowed Website URL** to `https://some-other-site.com`
2. Try to send a chat message from the demo page
3. Expected: `403 Origin not allowed` in the network tab

- [ ] Verify blocking works

### Step 7.3 — Verify fallback (no URL configured) still works

1. Clear the **Allowed Website URL** field and save
2. Reload the widget and try chat
3. Expected: chat succeeds (fallback to `*`)

- [ ] Verify fallback works

---

## Self-Review Notes

| Spec section | Task |
|---|---|
| Data layer: `widget_url` in `{t}_app_settings` | Task 1 (Steps 1.3–1.5) |
| GET returns `widget_url` + `backend_url` | Task 1 (Step 1.4) |
| PUT accepts `widget_url` | Task 1 (Step 1.5) |
| `/api/chat` per-tenant CORS | Task 2 |
| WebSocket per-tenant origin check | Task 3 |
| `data-backend-url` in widget.js | Task 4 |
| Frontend: website URL input | Task 5 (Step 5.5) |
| Frontend: `data-backend-url` in embed code | Task 5 (Step 5.4) |
| `PUBLIC_BACKEND_URL` env var | Task 6 |
