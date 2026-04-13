# Graph Report - .  (2026-04-11)

## Corpus Check
- Corpus is ~48,987 words - fits in a single context window. You may not need a graph.

## Summary
- 338 nodes · 614 edges · 40 communities detected
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 15 edges (avg confidence: 0.86)
- Token cost: 0 input · 0 output

## God Nodes (most connected - your core abstractions)
1. `api()` - 34 edges
2. `handleBookingStep()` - 22 edges
3. `toast()` - 21 edges
4. `Express.js Multi-Tenant Backend (src/)` - 19 edges
5. `getSuperDb()` - 17 edges
6. `handleRescheduleFlow()` - 14 edges
7. `saveBooking()` - 13 edges
8. `setSelect()` - 11 edges
9. `loadBookings()` - 11 edges
10. `forceRefreshData()` - 11 edges

## Surprising Connections (you probably didn't know these)
- `checkStaffAvailability() Function` --semantically_similar_to--> `Availability API (/api/availability/check, /slots)`  [INFERRED] [semantically similar]
  IMPLEMENTATION.md → src/CLAUDE.md
- `SQLite Database on Railway` --semantically_similar_to--> `salon.db â€” Tenant SQLite Database`  [INFERRED] [semantically similar]
  README.md → CLAUDE.md
- `Booking Status Flow (confirmedâ†’canceled/completed/no_show)` --semantically_similar_to--> `Booking Status Rules (CONFIRMED default, one-way cancel)`  [INFERRED] [semantically similar]
  src/CLAUDE.md → IMPLEMENTATION.md
- `Meta Webhooks (WhatsApp/Instagram/Facebook)` --semantically_similar_to--> `src/handlers/whatsapp.js â€” WhatsApp Webhook Handler`  [INFERRED] [semantically similar]
  README.md → src/CLAUDE.md
- `Intent Detection (Claude Haiku)` --semantically_similar_to--> `src/core/intent.js â€” NLP Intent Detection`  [INFERRED] [semantically similar]
  README.md → src/CLAUDE.md

## Hyperedges (group relationships)
- **Multi-Tenant SaaS Architecture: Backend + Frontend + Proxy** — claude_backend_src, claude_frontend_vercel, claude_nextjs_rewrite_proxy [EXTRACTED 1.00]
- **Booking Lifecycle: Duration + Staff Availability + Status Rules** — impl_staff_bookings_table, impl_booking_endtime, impl_booking_status_rules, impl_check_staff_availability_fn [EXTRACTED 0.95]
- **Meta Platform Webhook Integration: WhatsApp + Instagram + Facebook** — srcclaude_whatsapp_handler, srcclaude_instagram_handler, srcclaude_facebook_handler [EXTRACTED 1.00]

## Communities

### Community 0 - "Platform Architecture & Infrastructure"
Cohesion: 0.06
Nodes (46): Backend (src/) â€” Express API on Railway, BACKEND_URL Env Var (Vercel), Frontend (frontend/) â€” Next.js on Vercel, GEMINI_API_KEY Env Var, Next.js Rewrite Proxy (next.config.ts), salon.db â€” Tenant SQLite Database, Salon-Bot Multi-Tenant SaaS Platform, super.db â€” Super Admin & Tenant Registry (+38 more)

### Community 1 - "Admin Panel UI"
Cohesion: 0.09
Nodes (27): calculateEndTime(), checkBookingStaffAvailability(), editBooking(), editBranch(), editDeal(), editService(), editStaff(), formatDurationForInput() (+19 more)

### Community 2 - "Booking Reply Handlers"
Cohesion: 0.18
Nodes (26): branchList(), calculateEndTime(), checkStaffAvailability(), extractDate(), extractName(), extractPhone(), extractTime(), formatTime12h() (+18 more)

### Community 3 - "Booking System Implementation"
Cohesion: 0.13
Nodes (22): Advanced Booking System Implementation, Booking endTime Calculation, Booking Status Rules (CONFIRMED default, one-way cancel), calculateEndTime() Function, checkStaffAvailability() Function, Explicit vs Random Staff Assignment Pattern, getAvailableStaff() Function, Staff Overlap Detection Logic (+14 more)

### Community 4 - "Tenant Management"
Cohesion: 0.2
Nodes (19): authenticateTenant(), changeSuperAdminPassword(), createTenant(), createTenantTables(), generateTenantId(), getAllTenants(), getSuperDb(), getTenantByEmail() (+11 more)

### Community 5 - "Chat Widget Client"
Cohesion: 0.23
Nodes (16): appendMsg(), clearPlayback(), close(), getToneCtx(), open(), playConnectedSound(), playEndedSound(), playPCM16() (+8 more)

### Community 6 - "Admin Dashboard Actions"
Cohesion: 0.29
Nodes (19): api(), deleteBooking(), esc(), forceRefreshData(), loadBookings(), loadClients(), loadRevenuePieChart(), loadStaffDashboard() (+11 more)

### Community 7 - "Express Server Core"
Cohesion: 0.17
Nodes (8): autoMarkNoShowsForTenant(), checkBookingTimingWithEndTime(), checkStaffAvailability(), findAvailableStaff(), findNextAvailableSlots(), runJobsForAllTenants(), sendRemindersForTenant(), toMin()

### Community 8 - "Admin Settings & Branches UI"
Cohesion: 0.19
Nodes (14): buildBranchSubmenu(), deleteBranch(), deleteRole(), deleteStaff(), loadBranches(), loadGeneral(), loadRoles(), loadSettings() (+6 more)

### Community 9 - "Salon Data Cache"
Cohesion: 0.24
Nodes (8): _buildEmpty(), _buildFromDb(), _getCacheFile(), initCache(), _loadFromDisk(), patchCache(), refreshCache(), saveAtomic()

### Community 10 - "Deals & Branch UI"
Cohesion: 0.22
Nodes (13): closeModal(), deleteDeal(), loadDeals(), parseDurationInput(), renderDeals(), saveBranch(), saveDeal(), saveGeneral() (+5 more)

### Community 11 - "Database Layer"
Cohesion: 0.29
Nodes (10): createTenantTables(), dropTenantTables(), ensureTenantTables(), getDb(), getSettings(), initializeAllTenants(), initializeTenant(), invalidateSettingsCache() (+2 more)

### Community 12 - "WordPress Plugin"
Cohesion: 0.39
Nodes (5): salonbot_defaults(), salonbot_get(), salonbot_inject_widget(), salonbot_sanitize(), salonbot_settings_page()

### Community 13 - "Voice Call Server (Gemini Live)"
Cohesion: 0.47
Nodes (3): handleVoiceTool(), isWeekendForDate(), normalizeDateToISO()

### Community 14 - "Session Management"
Cohesion: 0.4
Nodes (0): 

### Community 15 - "Auth Middleware"
Cohesion: 0.5
Nodes (0): 

### Community 16 - "Prices & Services Replies"
Cohesion: 0.5
Nodes (0): 

### Community 17 - "Meta Message Sender"
Cohesion: 0.83
Nodes (3): send(), sendInstagramOrFacebook(), sendWhatsApp()

### Community 18 - "Services UI"
Cohesion: 0.67
Nodes (3): deleteService(), loadServices(), renderServices()

### Community 19 - "Facebook Webhook"
Cohesion: 0.67
Nodes (0): 

### Community 20 - "Instagram Webhook"
Cohesion: 0.67
Nodes (0): 

### Community 21 - "WhatsApp Webhook"
Cohesion: 0.67
Nodes (0): 

### Community 22 - "Branch Replies"
Cohesion: 1.0
Nodes (2): getBranches(), getBranchesReply()

### Community 23 - "Webhook Tenant Tests"
Cohesion: 0.67
Nodes (0): 

### Community 24 - "Widget Routing Tests"
Cohesion: 0.67
Nodes (0): 

### Community 25 - "Admin Auth"
Cohesion: 1.0
Nodes (0): 

### Community 26 - "Intent Detection"
Cohesion: 1.0
Nodes (0): 

### Community 27 - "Message Router"
Cohesion: 1.0
Nodes (0): 

### Community 28 - "Deals Replies"
Cohesion: 1.0
Nodes (0): 

### Community 29 - "SA01 Table Scripts"
Cohesion: 1.0
Nodes (0): 

### Community 30 - "Tenant Creation Script"
Cohesion: 1.0
Nodes (0): 

### Community 31 - "Auth Fix Script"
Cohesion: 1.0
Nodes (0): 

### Community 32 - "Logger"
Cohesion: 1.0
Nodes (0): 

### Community 33 - "Booking Lifecycle Tests"
Cohesion: 1.0
Nodes (0): 

### Community 34 - "DB Seed"
Cohesion: 1.0
Nodes (0): 

### Community 35 - "Check Tenant Script"
Cohesion: 1.0
Nodes (0): 

### Community 36 - "Ensure Super Admin Script"
Cohesion: 1.0
Nodes (0): 

### Community 37 - "Migrate Old to SA01 Script"
Cohesion: 1.0
Nodes (0): 

### Community 38 - "Migrate to Multitenant Script"
Cohesion: 1.0
Nodes (0): 

### Community 39 - "Tenant Isolation Tests"
Cohesion: 1.0
Nodes (0): 

## Knowledge Gaps
- **16 isolated node(s):** `BACKEND_URL Env Var (Vercel)`, `src/db/seed.js â€” Seed Data`, `Rationale: Remove PENDING Status â€” Always CONFIRMED Default`, `Rationale: One-Way Cancellation to Prevent Data Integrity Issues`, `Rationale: requestedCount Only on Explicit Selection â€” True Client Preference` (+11 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **Thin community `Admin Auth`** (2 nodes): `auth.js`, `requireAdminAuth()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Intent Detection`** (2 nodes): `intent.js`, `detectIntent()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Message Router`** (2 nodes): `router.js`, `routeMessage()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Deals Replies`** (2 nodes): `deals.js`, `getDealsReply()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `SA01 Table Scripts`** (2 nodes): `create-sa01-tables.js`, `createTenantTables()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Tenant Creation Script`** (2 nodes): `create-tenant.js`, `createNewTenant()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Auth Fix Script`** (2 nodes): `fix-auth.js`, `fixAuth()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Logger`** (2 nodes): `logger.js`, `timestamp()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Booking Lifecycle Tests`** (2 nodes): `booking-lifecycle.test.js`, `validateStatusTransition()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `DB Seed`** (1 nodes): `seed.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Check Tenant Script`** (1 nodes): `check-tenant.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Ensure Super Admin Script`** (1 nodes): `ensure-super-admin.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Migrate Old to SA01 Script`** (1 nodes): `migrate-old-to-sa01.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Migrate to Multitenant Script`** (1 nodes): `migrate-to-multitenant.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Tenant Isolation Tests`** (1 nodes): `tenant-isolation.test.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Express.js Multi-Tenant Backend (src/)` connect `Platform Architecture & Infrastructure` to `Booking System Implementation`?**
  _High betweenness centrality (0.022) - this node is a cross-community bridge._
- **Why does `BookingDrawer Component` connect `Platform Architecture & Infrastructure` to `Booking System Implementation`?**
  _High betweenness centrality (0.008) - this node is a cross-community bridge._
- **Why does `Advanced Booking System Implementation` connect `Booking System Implementation` to `Platform Architecture & Infrastructure`?**
  _High betweenness centrality (0.007) - this node is a cross-community bridge._
- **What connects `BACKEND_URL Env Var (Vercel)`, `src/db/seed.js â€” Seed Data`, `Rationale: Remove PENDING Status â€” Always CONFIRMED Default` to the rest of the system?**
  _16 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Platform Architecture & Infrastructure` be split into smaller, more focused modules?**
  _Cohesion score 0.06 - nodes in this community are weakly interconnected._
- **Should `Admin Panel UI` be split into smaller, more focused modules?**
  _Cohesion score 0.09 - nodes in this community are weakly interconnected._
- **Should `Booking System Implementation` be split into smaller, more focused modules?**
  _Cohesion score 0.13 - nodes in this community are weakly interconnected._