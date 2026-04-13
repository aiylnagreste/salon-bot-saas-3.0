# Backend — src/CLAUDE.md

Express.js multi-tenant SaaS backend. Entry point: `src/index.js`. Runs on port 3000.

## Architecture

```
src/
  index.js              ← all Express routes (monolithic, ~1800 lines)
  middleware/
    tenantAuth.js       ← JWT auth middleware
  db/
    database.js         ← better-sqlite3, tenant table creation, settings cache
    tenantManager.js    ← super.db CRUD, tenant registry, bcrypt auth
    seed.js             ← seed data for a tenant
  core/
    router.js           ← chat message routing (intent → reply handler)
    intent.js           ← NLP intent detection
    session.js          ← in-memory booking session store (Map, 10min TTL)
  cache/
    salonDataCache.js   ← per-tenant in-memory cache (services, deals, staff, etc.)
  handlers/
    whatsapp.js         ← Meta WhatsApp webhook handler
    instagram.js        ← Meta Instagram webhook handler
    facebook.js         ← Meta Facebook webhook handler
  replies/
    booking.js          ← 7-step conversational booking flow
    prices.js           ← price/service reply builders
    deals.js            ← deals reply builders
    branches.js         ← branch info reply builders
  server/
    apiCallLive.js      ← Gemini Live Audio WebSocket server (voice calls)
  utils/
    logger.js
    metaSender.js       ← sends WhatsApp/Instagram/Facebook messages via Meta API
  admin/
    auth.js
    views/              ← DELETED — replaced by Next.js frontend
```

## Auth Middleware

### `requireTenantAuth`
- Reads `tenantToken` cookie
- Verifies JWT signed with `TENANT_JWT_SECRET`
- Sets `req.tenantId` and `req.tenant` on success
- API routes return 401 JSON on failure; non-API routes redirect to `/salon-admin/login`

### `requireSuperAdminAuth`
- Reads `superAdminSession` cookie
- Verifies JWT, checks `role === 'super_admin'`
- Redirects to `/super-admin/login` on failure

### Token Generation
- Tenant token: `generateTenantToken(tenant)` — expires 7d, contains `tenantId`, `email`, `salonName`
- Super token: signed inline in `POST /super-admin/login` — expires 1d, contains `username`, `role`, `email`

## Database Schema

### salon.db — per-tenant tables (prefix = tenant_id e.g. `SA01`)

All tenant tables are named `{tenantId}_{tableName}`. Never query without the prefix.

| Table | Key Columns |
|-------|------------|
| `{t}_bookings` | id, customer_name, phone, service, branch, date (YYYY-MM-DD), time (HH:MM), endTime (HH:MM), status, source, staff_id, staff_name, staffRequested, reminder_sent, cancellation_reason |
| `{t}_services` | id, name, price (TEXT), description, branch, durationMinutes |
| `{t}_staff` | id, name, phone, role, branch_id (FK→branches), status (active/inactive) |
| `{t}_staff_roles` | id, name — roles that are NOT admin/manager/receptionist are "service providers" |
| `{t}_branches` | id, number, name, address, map_link, phone |
| `{t}_salon_timings` | id, day_type (workday/weekend), open_time, close_time |
| `{t}_deals` | id, title, description, active |
| `{t}_app_settings` | key, value — currency stored here |
| `{t}_business_settings` | key, value — cancellation_hours, reminder_hours |
| `{t}_customer_metrics` | phone, total_bookings, completed, no_shows, cancellations, total_spent, last_visit |
| `{t}_booking_audit` | booking_id, old_status, new_status, changed_by, reason |
| `{t}_staff_bookings` | staffId, bookingId, branchId, startTime, endTime, status |

### super.db
| Table | Key Columns |
|-------|------------|
| `super_admin` | id, username, password_hash (bcrypt), email |
| `tenants` | tenant_id (e.g. SA01), salon_name, owner_name, email, phone, password_hash, status (active/suspended) |
| `tenant_webhook_configs` | tenant_id, wa_phone_number_id, wa_access_token, wa_verify_token, ig_page_access_token, ig_verify_token, fb_page_access_token, fb_verify_token |

### Booking Status Flow
```
confirmed → canceled (terminal)
confirmed → completed (terminal)
confirmed → no_show → confirmed (can undo false no-show)
```
`archived` = soft-deleted (DELETE endpoint sets this, never physically removes rows)

## All Routes

### Public / Health
| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Health check — returns "Salon Bot is running ✅" |
| GET | `/widget/:tenantId/widget.js` | Serves widget.js for embedding |
| GET | `/salon-config/:tenantId` | Widget bootstrap — returns salon_name, bot_name, primary_color |
| GET | `/salon-data.json?tenantId=&key=` | Returns full salon cache (requires SALON_DATA_KEY) |

### Chat (Web Widget)
| Method | Path | Description |
|--------|------|-------------|
| OPTIONS | `/api/chat` | CORS preflight |
| POST | `/api/chat` | `{message, sessionId, tenantId}` → `{reply}`. Rate limited 60/min per session |

### Availability (Public — used by widget)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/availability/check?branch=&date=&time=&service=&tenantId=` | Check if slot is available, returns availableStaff array |
| GET | `/api/availability/slots?branch=&date=&service=&tenantId=` | List all available slots in 30-min increments |

### Customer Self-Service (Public)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/customer/bookings?phone=&tenantId=` | Customer's booking history + metrics |
| POST | `/api/customer/cancel` | `{bookingId, phone, reason, tenantId}` — respects cancellation_hours setting |

### Meta Webhooks
| Method | Path | Description |
|--------|------|-------------|
| GET/POST | `/webhook` | Legacy single-tenant webhook (logs warning, use per-tenant instead) |
| GET | `/webhooks/:tenantSlug/whatsapp` | WhatsApp verification |
| POST | `/webhooks/:tenantSlug/whatsapp` | WhatsApp message handler |
| GET | `/webhooks/:tenantSlug/instagram` | Instagram verification |
| POST | `/webhooks/:tenantSlug/instagram` | Instagram message handler |
| GET | `/webhooks/:tenantSlug/facebook` | Facebook verification |
| POST | `/webhooks/:tenantSlug/facebook` | Facebook message handler |

### Salon Admin — Auth (no middleware)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/salon-admin/login` | `{email, password}` → sets `tenantToken` cookie (7d), returns `{success, redirect}`. Rate limited 5/15min |
| GET | `/salon-admin/logout` | Clears `tenantToken` cookie |

> `GET /salon-admin/login` and `GET /salon-admin/dashboard` HTML routes have been REMOVED — handled by Next.js frontend now

### Salon Admin — Stats (`requireTenantAuth`)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/salon-admin/api/stats?tz=` | total_bookings, today_bookings, active_services, total_clients |
| GET | `/salon-admin/api/analytics?branch=&period=&from=&to=&status=&tz=` | Revenue, top services, bookings by branch. period=day/week/month/year |

### Salon Admin — Bookings (`requireTenantAuth`)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/salon-admin/api/bookings?date=&status=&limit=` | List bookings, filtered |
| POST | `/salon-admin/api/bookings` | Create booking — auto-assigns staff if none specified |
| PUT | `/salon-admin/api/bookings/:id` | Full update — re-checks staff availability |
| PATCH | `/salon-admin/api/bookings/:id/status` | Status transition only — validates allowed transitions |
| PATCH | `/salon-admin/api/bookings/:id/no-show` | Mark as no-show (confirmed only) |
| DELETE | `/salon-admin/api/bookings/:id` | Soft-delete (sets status=archived) |

### Salon Admin — Clients (`requireTenantAuth`)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/salon-admin/api/clients` | Unique clients with booking_count and last_visit |
| GET | `/salon-admin/api/customer-analytics` | topCustomers, repeatRate, noShowRate, atRiskCustomers |

### Salon Admin — Services (`requireTenantAuth`)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/salon-admin/api/services` | All services |
| POST | `/salon-admin/services` | Bulk upsert — body: `{services: [...]}` |

### Salon Admin — Deals (`requireTenantAuth`)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/salon-admin/api/deals` | All deals |
| POST | `/salon-admin/deals` | Bulk upsert — body: `{deals: [...]}` |

### Salon Admin — Settings (`requireTenantAuth`)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/salon-admin/api/settings/branches` | All branches |
| POST | `/salon-admin/api/settings/branches` | Create branch |
| PUT | `/salon-admin/api/settings/branches/:id` | Update branch |
| DELETE | `/salon-admin/api/settings/branches/:id` | Delete branch |
| GET | `/salon-admin/api/settings/staff` | All staff (joined with branch_name) |
| POST | `/salon-admin/api/settings/staff` | Create staff |
| PUT | `/salon-admin/api/settings/staff/:id` | Update staff |
| DELETE | `/salon-admin/api/settings/staff/:id` | Delete staff |
| GET | `/salon-admin/api/settings/roles` | All staff roles |
| POST | `/salon-admin/api/settings/roles` | Create role |
| DELETE | `/salon-admin/api/settings/roles/:id` | Delete role |
| GET | `/salon-admin/api/settings/timings` | workday + weekend timings |
| PUT | `/salon-admin/api/settings/timings` | Update timings — body: `{workday: {open_time, close_time}, weekend: {...}}` |
| GET | `/salon-admin/api/settings/general` | currency + tenantId |
| PUT | `/salon-admin/api/settings/general` | Update currency |
| PUT | `/salon-admin/api/salon-name` | Update salon name |
| GET | `/salon-admin/api/webhook-config` | Returns webhook metadata only (never returns tokens) |
| PUT | `/salon-admin/api/webhook-config` | Save per-tenant WhatsApp/Instagram/Facebook credentials |

### Super Admin — Auth (no middleware)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/super-admin/login` | `{username, password}` → sets `superAdminSession` cookie (1d). Rate limited 3/15min |
| GET | `/super-admin/logout` | Clears `superAdminSession` cookie |

> `GET /super-admin/login` and `GET /super-admin/dashboard` HTML routes REMOVED — handled by Next.js

### Super Admin — API (`requireSuperAdminAuth`)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/super-admin/api/stats` | total_tenants, active_tenants |
| GET | `/super-admin/api/tenants` | All tenants from super.db |
| POST | `/super-admin/api/tenants` | Create tenant — `{owner_name, salon_name, email, phone, password}` |
| PATCH | `/super-admin/api/tenants/:tenantId/status` | Set active/suspended |
| POST | `/super-admin/api/settings` | `{default_plan}` — sets process.env |

### Utility
| Method | Path | Description |
|--------|------|-------------|
| GET | `/run-seed?key=&tenantId=` | Re-seeds tenant data (requires SALON_DATA_KEY) |

## Staff Assignment Logic

When creating/updating a booking:
1. If `staff_id` provided → validate branch match → check availability → block if conflict
2. If no `staff_id` → `findAvailableStaff()` → picks random free staff → auto-assigns
3. Service-provider roles = any role NOT in `(admin, manager, receptionist)`
4. `staffRequested=1` if staff was explicitly chosen, `0` if auto-assigned

## Background Jobs (run every 15 min)
- **Auto no-show**: marks `confirmed` bookings as `no_show` after `endTime + NO_SHOW_GRACE_MIN`
- **Reminders**: logs reminder intent for bookings due in `reminder_hours` (no actual send yet)

## Cache (`salonDataCache.js`)
Per-tenant in-memory cache. Keys: `bookings`, `services`, `deals`, `branches`, `staff`, `staffRoles`, `salonTimings`, `appSettings`. Use `patchCache(tenantId, key, op, data)` after mutations. `initCache(tenantId)` pre-warms on startup.

## Voice Calls (`apiCallLive.js`)
WebSocket server mounted on the same HTTP server. Uses Gemini Live Audio API (`@google/genai`). Handles Urdu/Punjabi date-time parsing: `kal`→tomorrow, `parson`→day after tomorrow, `aaj`→today, `2 baje`→02:00.