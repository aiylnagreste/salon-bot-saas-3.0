// ─────────────────────────────────────────────────────────────────────────────
//  salon-bot  ·  src/index.js  ·  Multi-Tenant SaaS Entry Point
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

require("dotenv").config();

const crypto = require("crypto");
const express = require("express");
const path = require("path");
const http = require("http");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

const logger = require("./utils/logger");
const { isValidPhone, normalizePhone } = require("./utils/phone");
const { initializeAllTenants, getDb, invalidateSettingsCache } = require("./db/database");
const { setupCallServer } = require("./server/apiCallLive.js");
const { initCache, getCache, patchCache } = require("./cache/salonDataCache");

// Tenant / Super-Admin helpers
const {
  getSuperDb,
  getAllTenants,
  createTenant,
  updateTenantStatus,
  authenticateTenant,
  getTenantById,
  updateSalonName,
  isTenantActive,
  getTenantAccessStatus,
  getWebhookConfig,
  upsertWebhookConfig,
  clearWebhookChannel,
  setCredentialsValid,
  updateTenantPassword,
  changeSuperAdminPassword,
  getAllPlans,
  getActivePlans,
  getPlanById,
  createPlan,
  updatePlan,
  deletePlan,
  hardDeletePlan,
  createSubscription,
  updateSubscription,
  updateSubscriptionByTenantId,
  cancelSubscription,
  setTenantPlanOverride,
  getSubscriptions,
  storeResetToken,
  getValidResetToken,
  markResetTokenUsed,
  getTenantSubscription,
  getTenantCorsOrigin,
  setTenantCorsOrigin,
  freezeExcessServices,
  unfreezeServices,
} = require("./db/tenantManager");

// Auth middleware
const {
  requireSuperAdminAuth,
  requireTenantAuth,
  generateTenantToken,
} = require("./middleware/tenantAuth");
const { requirePlanFeature } = require("./middleware/planGate");

// Platform webhook handlers
const { handleWhatsApp, verifyWhatsApp } = require("./handlers/whatsapp");
const { handleInstagram, verifyInstagram } = require("./handlers/instagram");
const { handleFacebook, verifyFacebook } = require("./handlers/facebook");

// Chat router (web widget)
const { routeMessage } = require("./core/router");

const { sendWelcomeEmail, sendPasswordResetEmail, sendPlanUpgradeEmail, sendPlanDowngradeEmail } = require('./services/emailService');
const { createCheckoutSession,createUpgradeCheckoutSession, constructWebhookEvent, retrieveSubscription } = require('./services/stripeService');
const { testWhatsAppCredentials, testInstagramCredentials, testFacebookCredentials } = require('./utils/metaCredentialTester');

// ── JWT secret — REQUIRED in production ──────────────────────────────────────
const JWT_SECRET = process.env.TENANT_JWT_SECRET;
if (!JWT_SECRET) {
  console.error("FATAL: TENANT_JWT_SECRET env var is not set. Set it to a 32-byte random hex string.");
  process.exit(1);
}

// ── Simple in-memory rate limiter ─────────────────────────────────────────────
const _rateBuckets = new Map(); // key → { count, resetAt }
function rateLimit(key, maxRequests, windowMs) {
  const now = Date.now();
  let bucket = _rateBuckets.get(key);
  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 0, resetAt: now + windowMs };
    _rateBuckets.set(key, bucket);
  }
  bucket.count++;
  return bucket.count > maxRequests; // true = rate limited
}
// Clean up stale buckets every 5 min
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _rateBuckets) if (now > v.resetAt) _rateBuckets.delete(k);
}, 300_000);

const NO_SHOW_GRACE_MIN = parseInt(process.env.NO_SHOW_GRACE_MIN || "30", 10);
const NO_SHOW_SCAN_MS = 15 * 60 * 1000; // every 15 min

// ─────────────────────────────────────────────────────────────────────────────
//  Express setup
// ─────────────────────────────────────────────────────────────────────────────
const app = express();
const PORT = process.env.PORT || 3000;

// Raw body needed for Stripe webhook signature verification — MUST be before express.json()
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// Minimal cookie parser (no extra dependency)
app.use((req, _res, next) => {
  const raw = req.headers.cookie || "";
  req.cookies = Object.fromEntries(
    raw
      .split(";")
      .filter(Boolean)
      .map((c) => c.trim().split("=").map(decodeURIComponent))
  );
  next();
});
app.use('/salon-admin/api', (err, req, res, next) => {
  if (err) {
    console.error('API Error:', err.message);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
  next();
});
app.use((req, res, next) => {
  const allowedOrigins = [getTenantCorsOrigin(req.headers.origin)
  ].filter(Boolean);
  const origin = req.headers.origin;

  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Cookie, Set-Cookie, Authorization');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});



// In index.js - Add this endpoint for verification
app.post("/api/stripe/verify-subscription", async (req, res) => {
  try {
    const { session_id, is_upgrade } = req.body;
    
    if (!session_id) {
      return res.status(400).json({ error: "session_id required" });
    }
    
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    const session = await stripe.checkout.sessions.retrieve(session_id, {
      expand: ['subscription', 'customer']
    });
    
    if (session.payment_status === 'paid') {
      // If this was an upgrade, you might want to update the subscription here
      // But the webhook should already handle that
      
      return res.json({ 
        success: true, 
        subscription_id: session.subscription?.id,
        is_upgrade: is_upgrade || false,
        customer_id: session.customer?.id
      });
    } else {
      return res.json({ 
        success: false, 
        error: "Payment not completed" 
      });
    }
  } catch (err) {
    console.error("[verify-subscription] Error:", err.message);
    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});
// CORS for widget.js
app.use("/widget.js", (_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  next();
});

// Conditional per-tenant CORS for widget/voice endpoints
// Only applies to non-admin, non-webhook routes. Looks up the tenant by the
// requesting Origin stored in salon_tenants.cors_origin, then checks the
// tenant's active subscription for widget_access or ai_calls_access before
// granting CORS. Fails silently to avoid breaking unrelated requests.
app.use((req, res, next) => {
  // Skip admin and webhook routes — they have their own CORS rules
  if (req.path.startsWith('/salon-admin') || req.path.startsWith('/webhooks')) {
    return next();
  }

  const origin = req.headers.origin;
  if (!origin) return next();

  try {
    const db = getSuperDb();
    const tenantRow = db.prepare(
      'SELECT tenant_id FROM salon_tenants WHERE cors_origin = ? AND status = ?'
    ).get(origin, 'active');
    if (!tenantRow) return next();

    const sub = getTenantSubscription(tenantRow.tenant_id);
    if (!sub || (sub.widget_access !== 1 && sub.ai_calls_access !== 1)) return next();

    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
  } catch (e) {
    // fail silently — CORS is best-effort, do not break the request
  }
  next();
});

// Serve /public (widget.js lives here)
app.use(express.static(path.join(__dirname, "../public")));

// Per-tenant widget URL: /widget/SA_01/widget.js
// widget.js auto-extracts tenantId from this URL pattern
app.get("/widget/:tenantId/widget.js", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/javascript");
  res.sendFile(path.join(__dirname, "../public/widget.js"));
});

// ─────────────────────────────────────────────────────────────────────────────
//  Helper functions
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
//  VALIDATION — booking body
//  Pass isEdit=true on PUT so past-date check is skipped
// ─────────────────────────────────────────────────────────────────────────────
function validateBookingBody(body, isEdit = false) {
  const { customer_name, phone, service, branch, date, time } = body;
  const errs = [];
  if (!customer_name?.trim()) errs.push("customer_name");
  if (!phone?.trim()) errs.push("phone");
  else if (!isValidPhone(phone)) errs.push("phone (must be 8-15 digits, optional leading '+')");
  if (!service?.trim()) errs.push("service");
  if (!branch?.trim()) errs.push("branch");
  if (!time?.trim()) errs.push("time");

  if (!date?.trim()) {
    errs.push("date");
  } else if (!isEdit) {
    const today = new Date().toISOString().slice(0, 10);
    if (date.trim() < today) errs.push("date (cannot be in the past)");
  }
  return errs;
}

function calculateEndTime(startHHMM, durationMinutes) {
  if (!startHHMM || !durationMinutes) return startHHMM;
  const [h, m] = startHHMM.split(":").map(Number);
  const totalMin = h * 60 + m + Number(durationMinutes);
  const newH = Math.floor(totalMin / 60) % 24;
  const newM = totalMin % 60;
  return `${String(newH).padStart(2, "0")}:${String(newM).padStart(2, "0")}`;
}

function getServiceDuration(serviceName, db, tenantId) {
  try {
    const svc = db
      .prepare(`SELECT durationMinutes FROM ${tenantId}_services WHERE name = ?`)
      .get(serviceName);
    return svc ? svc.durationMinutes : 60;
  } catch {
    return 60;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  TIMING CHECK — start + end both within salon hours
// ─────────────────────────────────────────────────────────────────────────────
function checkBookingTimingWithEndTime(date, time, endTime, db, tenantId) {
  const dow = new Date(date).getDay();
  const dayType = dow === 0 || dow === 6 ? "weekend" : "workday";
  const timing = db
    .prepare(`SELECT * FROM ${tenantId}_salon_timings WHERE day_type = ?`)
    .get(dayType);

  if (!timing) return null; // no timings configured → allow

  const startMin = toMin(time);
  const endMin = toMin(endTime);
  const openMin = toMin(timing.open_time);
  const closeMin = toMin(timing.close_time);

  if (isNaN(startMin) || isNaN(openMin) || isNaN(closeMin))
    return `Could not parse salon timing or booking time`;

  if (startMin < openMin || startMin > closeMin)
    return `Start time ${time} is outside ${dayType} hours (${timing.open_time}–${timing.close_time})`;

  if (!isNaN(endMin) && endMin > closeMin)
    return `End time ${endTime} exceeds ${dayType} closing time (${timing.close_time})`;

  return null;
}


// ─────────────────────────────────────────────────────────────────────────────
//  STAFF BRANCH CHECK
// ─────────────────────────────────────────────────────────────────────────────
function checkStaffBranch(staffId, branch, db, tenantId) {
  // Guard: null, undefined, empty string, 0 — all mean "no staff selected"
  if (!staffId || staffId === '' || staffId === 0 || staffId === '0') return null;
  const id = parseInt(staffId, 10);
  if (isNaN(id)) return null;
  const staff = db.prepare(`SELECT * FROM ${tenantId}_staff WHERE id = ?`).get(id);
  if (!staff) return "Selected staff member not found.";
  if (staff.branch_id === null) return null; // unassigned staff → works everywhere
  const br = db.prepare(`SELECT id FROM ${tenantId}_branches WHERE name = ?`).get(branch);
  if (!br || staff.branch_id !== br.id)
    return "Selected staff does not belong to this branch.";
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
//  HELPER — parse "HH:MM" or "YYYY-MM-DD HH:MM" safely → total minutes
//  Returns NaN only if the string is genuinely unparseable
// ─────────────────────────────────────────────────────────────────────────────
function toMin(timeStr) {
  if (!timeStr) return NaN;
  // Strip date prefix if present ("2026-04-08 14:30" → "14:30")
  const t = timeStr.includes(" ") ? timeStr.split(" ")[1] : timeStr;
  const parts = t.split(":").map(Number);
  if (parts.length < 2 || isNaN(parts[0]) || isNaN(parts[1])) return NaN;
  return parts[0] * 60 + parts[1];
}

// ─────────────────────────────────────────────────────────────────────────────
//  STAFF AVAILABILITY CHECK (single staff, for POST/PUT with explicit staff_id)
//  excludeBookingId — pass the booking being edited so it doesn't conflict
//  with itself
// ─────────────────────────────────────────────────────────────────────────────
function checkStaffAvailability(staffId, date, startTime, endTime, db, tenantId, excludeBookingId = null) {
  if (!staffId) return null;

  const newStart = toMin(startTime);
  const newEnd = toMin(endTime);

  if (isNaN(newStart) || isNaN(newEnd)) {
    logger.warn(`[STAFF-AVAIL] Could not parse time: ${startTime} / ${endTime}`);
    return null; // don't block on bad input — let timing check catch it
  }

  let sql = `
    SELECT id, time, endTime, service FROM ${tenantId}_bookings
    WHERE staff_id = ? AND date = ? AND status = 'confirmed'
  `;
  const params = [staffId, date];
  if (excludeBookingId) {
    sql += ` AND id != ?`;
    params.push(excludeBookingId);
  }

  const conflicts = db.prepare(sql).all(...params);

  for (const b of conflicts) {
    const exStart = toMin(b.time);
    // endTime may be null on older bookings — fall back to 60-min default
    const exEnd = !isNaN(toMin(b.endTime)) ? toMin(b.endTime) : exStart + 60;

    if (isNaN(exStart)) continue; // corrupt row — skip

    // Overlap condition: new starts before existing ends AND new ends after existing starts
    if (newStart < exEnd && newEnd > exStart) {
      const fmt = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
      return `Staff already booked from ${fmt(exStart)} to ${fmt(exEnd)} (${b.service || "another service"})`;
    }
  }

  return null; // no conflict
}

// ─────────────────────────────────────────────────────────────────────────────
//  FIND AVAILABLE STAFF for a given slot (used when no staff_id is specified)
//  Returns array of staff objects that are free in [startTime, endTime]
// ─────────────────────────────────────────────────────────────────────────────
function findAvailableStaff(date, startTime, endTime, branch, db, tenantId) {
  const newStart = toMin(startTime);
  const newEnd = toMin(endTime);

  console.log(`[FIND-STAFF] === DEBUG START ===`);
  console.log(`[FIND-STAFF] Input: date=${date}, startTime=${startTime}, endTime=${endTime}, branch=${branch}, tenantId=${tenantId}`);

  if (isNaN(newStart) || isNaN(newEnd)) {
    logger.warn(`[FIND-STAFF] Unparseable slot: ${startTime}–${endTime}`);
    return [];
  }

  // ── 1. Resolve branch id ──────────────────────────────────────────────────
  const branchRow = db.prepare(`SELECT id FROM ${tenantId}_branches WHERE name = ?`).get(branch);
  const branchId = branchRow ? branchRow.id : null;
  console.log(`[FIND-STAFF] Branch: ${branch}, branchId: ${branchId}`);

  // ── 2. Get service-provider roles (excludes admin/manager/receptionist) ───
  let serviceRoles = [];
  try {
    serviceRoles = db
      .prepare(`SELECT name FROM ${tenantId}_staff_roles WHERE name NOT IN ('admin','manager','receptionist')`)
      .all()
      .map((r) => r.name);
    console.log(`[FIND-STAFF] Service roles from DB:`, serviceRoles);
  } catch (e) {
    logger.warn(`[FIND-STAFF] Could not load roles: ${e.message}`);
    console.log(`[FIND-STAFF] Error loading roles:`, e.message);
  }

  // ── 3. Fetch candidate staff ──────────────────────────────────────────────
  let staffList = [];
  try {
    if (serviceRoles.length > 0) {
      const ph = serviceRoles.map(() => "?").join(",");
      const sql = `
        SELECT s.* FROM ${tenantId}_staff s
        WHERE s.status = 'active'
          AND s.role IN (${ph})
          AND (s.branch_id = ? OR s.branch_id IS NULL)
      `;
      console.log(`[FIND-STAFF] SQL with roles:`, sql);
      console.log(`[FIND-STAFF] Parameters: roles=${serviceRoles.join(', ')}, branchId=${branchId}`);

      staffList = db.prepare(sql).all(...serviceRoles, branchId);
    } else {
      const sql = `
        SELECT s.* FROM ${tenantId}_staff s
        WHERE s.status = 'active'
          AND s.role NOT IN ('admin', 'manager', 'receptionist')
          AND (s.branch_id = ? OR s.branch_id IS NULL)
      `;
      console.log(`[FIND-STAFF] SQL without roles:`, sql);
      staffList = db.prepare(sql).all(branchId);
    }

    console.log(`[FIND-STAFF] Staff found: ${staffList.length}`);
    staffList.forEach(s => {
      console.log(`[FIND-STAFF]   - ${s.name}, role: ${s.role}, branch_id: ${s.branch_id}, status: ${s.status}`);
    });
  } catch (e) {
    logger.error(`[FIND-STAFF] Staff query failed: ${e.message}`);
    console.error(`[FIND-STAFF] Error:`, e);
    return [];
  }

  if (staffList.length === 0) {
    logger.warn(`[FIND-STAFF] No active service-provider staff found for branch "${branch}" (branchId=${branchId})`);
    console.log(`[FIND-STAFF] No staff found - check branch assignment!`);
    return [];
  }

  // ── 4. Pre-fetch all confirmed bookings for this date/branch once ─────────
  let dateBookings = [];
  try {
    dateBookings = db
      .prepare(`
        SELECT staff_id, time, endTime, service FROM ${tenantId}_bookings
        WHERE date = ? AND status = 'confirmed' AND branch = ?
      `)
      .all(date, branch);
    console.log(`[FIND-STAFF] Bookings on ${date} for branch ${branch}: ${dateBookings.length}`);
  } catch (e) {
    logger.error(`[FIND-STAFF] Booking query failed: ${e.message}`);
    console.log(`[FIND-STAFF] Error loading bookings:`, e.message);
  }

  // ── 5. Filter to free staff ───────────────────────────────────────────────
  const freeStaff = staffList.filter((staff) => {
    const staffBookings = dateBookings.filter((b) => b.staff_id === staff.id);

    if (staffBookings.length === 0) {
      console.log(`[FIND-STAFF] ${staff.name} has NO bookings on this date - FREE`);
      return true;
    }

    for (const b of staffBookings) {
      const exStart = toMin(b.time);
      const exEnd = !isNaN(toMin(b.endTime)) ? toMin(b.endTime) : exStart + 60;

      if (isNaN(exStart)) continue;

      if (newStart < exEnd && newEnd > exStart) {
        console.log(`[FIND-STAFF] ${staff.name} BUSY: ${b.time}–${b.endTime || '(no endTime)'} overlaps ${startTime}–${endTime}`);
        return false;
      }
    }

    console.log(`[FIND-STAFF] ${staff.name} is FREE at ${startTime}–${endTime}`);
    return true;
  });

  console.log(`[FIND-STAFF] Free staff count: ${freeStaff.length}`);
  console.log(`[FIND-STAFF] === DEBUG END ===`);

  return freeStaff;
}


// ─────────────────────────────────────────────────────────────────────────────
//  FIND NEXT AVAILABLE SLOTS (for suggesting alternatives in the widget)
// ─────────────────────────────────────────────────────────────────────────────
function findNextAvailableSlots(date, branch, durationMinutes, db, tenantId) {
  const dow = new Date(date).getDay();
  const dayType = dow === 0 || dow === 6 ? "weekend" : "workday";
  const timing = db
    .prepare(`SELECT * FROM ${tenantId}_salon_timings WHERE day_type = ?`)
    .get(dayType);

  if (!timing) return [];

  const openMin = toMin(timing.open_time);
  const closeMin = toMin(timing.close_time);

  if (isNaN(openMin) || isNaN(closeMin)) return [];

  const slots = [];
  let cursor = openMin;
  const fmt = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

  while (cursor + durationMinutes <= closeMin) {
    const slotTime = fmt(cursor);
    const slotEndTime = fmt(cursor + durationMinutes);
    const available = findAvailableStaff(date, slotTime, slotEndTime, branch, db, tenantId);

    if (available.length > 0) {
      slots.push({
        time: slotTime,
        endTime: slotEndTime,
        availableStaff: available.length,
      });
    }
    cursor += 30; // 30-minute increments
  }

  return slots;
}

// Valid status transitions — anything not in this map is rejected
const STATUS_TRANSITIONS = {
  confirmed:   ["canceled", "completed", "no_show", "arrived"],
  arrived:     ["canceled", "no_show", "completed"],  // arrived clients can still be canceled/no-show (defensive); invoice flow sets completed
  no_show:     ["confirmed"],  // allow un-marking a false no-show
  canceled:    [],             // terminal — no restoring
  completed:   [],             // terminal
};

function validateStatusTransition(currentStatus, newStatus) {
  const curr = (currentStatus || "confirmed").toLowerCase();
  const next = (newStatus || "").toLowerCase();
  if (curr === next) return null; // no-op
  const allowed = STATUS_TRANSITIONS[curr] || [];
  if (!allowed.includes(next))
    return `Cannot change status from '${curr}' to '${next}'. Allowed: ${allowed.join(", ") || "none"}.`;
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Health + chat
// ─────────────────────────────────────────────────────────────────────────────

app.get("/", (_req, res) => res.send("Salon Bot is running ✅"));

// CORS pre-flight for chat — look up tenant by origin
app.options("/api/chat", (req, res) => {
  const origin = req.headers.origin;
  if (origin) {
    try {
      const db = getSuperDb();
      const row = db.prepare(
        'SELECT tenant_id FROM salon_tenants WHERE cors_origin = ? AND status = ?'
      ).get(origin, 'active');
      if (row) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Access-Control-Allow-Credentials", "true");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");
        res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
        return res.sendStatus(204);
      }
    } catch (_e) { /* fall through */ }
  }
  res.sendStatus(403);
});

app.post("/api/chat", async (req, res) => {
  const { message, sessionId, tenantId } = req.body;
  if (!message || !sessionId)
    return res.status(400).json({ error: "message and sessionId required" });
  if (!tenantId)
    return res.status(400).json({ error: "tenantId required" });

  // Enforce per-tenant CORS origin — block if not configured
  const corsOrigin = getTenantCorsOrigin(tenantId);
  if (!corsOrigin)
    return res.status(403).json({ error: "Chat not enabled for this salon" });
  const requestOrigin = req.headers.origin;
  if (!requestOrigin || requestOrigin !== corsOrigin)
    return res.status(403).json({ error: "Origin not allowed" });
  res.setHeader("Access-Control-Allow-Origin", corsOrigin);
  res.setHeader("Access-Control-Allow-Credentials", "true");

  // Rate limit: 60 messages / minute per sessionId
  if (rateLimit(`chat:${sessionId}`, 60, 60_000))
    return res.status(429).json({ error: "Too many messages. Please slow down." });

  // Validate tenant is active
  if (!isTenantActive(tenantId))
    return res.status(403).json({ error: "Salon not found or inactive" });

  try {
    const reply = await routeMessage(sessionId, message.trim(), "webchat", tenantId);
    res.json({ reply });
  } catch (err) {
    logger.error("[chat-api] Error:", err.message);
    res.status(500).json({ error: "Something went wrong" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  Meta webhooks
// ─────────────────────────────────────────────────────────────────────────────

// ── Legacy single-tenant webhook (kept for backwards compat; logs a warning) ──
app.get("/webhook", (req, res) => {
  if (req.query["hub.verify_token"] === process.env.META_VERIFY_TOKEN) {
    logger.warn("[Webhook] Legacy /webhook used. Migrate to /webhooks/:tenantSlug/<platform>");
    return res.status(200).send(req.query["hub.challenge"]);
  }
  res.sendStatus(403);
});

app.post("/webhook", (req, res) => {
  logger.warn("[Webhook] Legacy /webhook — no tenantId context. Messages will be dropped.");
  const obj = req.body?.object;
  if (obj === "whatsapp_business_account") return handleWhatsApp(req, res, null, null);
  if (obj === "instagram") return handleInstagram(req, res, null, null);
  if (obj === "page") return handleFacebook(req, res, null, null);
  res.sendStatus(200);
});

// ── Per-tenant webhook middleware ─────────────────────────────────────────────
function tenantWebhookMiddleware(req, res, next) {
  const slug = req.params.tenantSlug;
  if (!slug) return res.status(400).json({ error: "tenantSlug required" });

  const tenant = getTenantById(slug);
  if (!tenant || tenant.status !== "active")
    return res.status(404).json({ error: "Salon not found or inactive" });

  req.tenantId = tenant.tenant_id;
  req.webhookConfig = getWebhookConfig(tenant.tenant_id);
  next();
}

// Per-tenant WhatsApp
app.get("/webhooks/:tenantSlug/whatsapp", tenantWebhookMiddleware, (req, res) =>
  verifyWhatsApp(req, res, req.webhookConfig, req.tenantId));
app.post("/webhooks/:tenantSlug/whatsapp", tenantWebhookMiddleware, (req, res) =>
  handleWhatsApp(req, res, req.tenantId, req.webhookConfig));

// Per-tenant Instagram
app.get("/webhooks/:tenantSlug/instagram", tenantWebhookMiddleware, (req, res) =>
  verifyInstagram(req, res, req.webhookConfig, req.tenantId));
app.post("/webhooks/:tenantSlug/instagram", tenantWebhookMiddleware, (req, res) =>
  handleInstagram(req, res, req.tenantId, req.webhookConfig));

// Per-tenant Facebook
app.get("/webhooks/:tenantSlug/facebook", tenantWebhookMiddleware, (req, res) =>
  verifyFacebook(req, res, req.webhookConfig, req.tenantId));
app.post("/webhooks/:tenantSlug/facebook", tenantWebhookMiddleware, (req, res) =>
  handleFacebook(req, res, req.tenantId, req.webhookConfig));

// ─────────────────────────────────────────────────────────────────────────────
//  Salon-config endpoint (for multi-tenant widget bootstrap)
// ─────────────────────────────────────────────────────────────────────────────

app.get("/salon-config/:tenantId", async (req, res) => {
  const { tenantId } = req.params;
  const tenant = getTenantById(tenantId);
  if (!tenant || tenant.status !== "active")
    return res.status(404).json({ error: "Salon not found" });

  await initCache(tenantId);
  const settings = (() => {
    const rows = getDb().prepare(`SELECT key, value FROM ${tenantId}_app_settings`).all();
    const r = {};
    rows.forEach((row) => { r[row.key] = row.value; });
    return r;
  })();
  res.json({
    salon_name: tenant.salon_name,
    bot_name: settings.bot_name || tenant.salon_name,
    primary_color: settings.primary_color || "#8b4a6b",
    // ws_url: not needed when widget loads directly from Railway (baseUrl = Railway origin).
    // Kept for backwards compatibility with any widgets still loading through the Vercel proxy.
    ws_url: (process.env.PUBLIC_URL || "").replace(/\/$/, ""),
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Salon-data JSON cache endpoint (for external/widget use)
// ─────────────────────────────────────────────────────────────────────────────

app.get("/salon-data.json", (req, res) => {
  const { tenantId, key } = req.query;
  if (!tenantId) return res.status(400).json({ error: "tenantId required" });
  const expectedKey = process.env.SALON_DATA_KEY || "adminkey123";
  if (!key || key !== expectedKey) return res.status(401).json({ error: "Unauthorized" });
  const cache = getCache(tenantId);
  if (!cache) return res.status(503).json({ error: "Cache not ready" });
  res.json(cache);
});

// ─────────────────────────────────────────────────────────────────────────────
// ── Tenant Auth — Forgot / Reset Password ─────────────────────────────────────

app.post("/tenant/forgot-password", async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'email required' });

    // Always return 200 immediately — don't leak whether email exists
    res.json({ ok: true });

    setImmediate(async () => {
        try {
            const superDb = getSuperDb();
            const tenant = superDb.prepare(
                "SELECT * FROM salon_tenants WHERE email = ? AND status = 'active'"
            ).get(email);
            if (!tenant) return;

            const rawToken = crypto.randomBytes(32).toString('hex');
            const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
            // 5-minute expiry
            const expiresAt = new Date(Date.now() + 5 * 60 * 1000)
                .toISOString().replace('T', ' ').slice(0, 19);

            storeResetToken(tenant.tenant_id, tokenHash, expiresAt);

            const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3002';
            const resetUrl = `${frontendUrl}/reset-password?token=${rawToken}`;

            await sendPasswordResetEmail({
                to: tenant.email,
                ownerName: tenant.owner_name,
                resetUrl,
            });
            logger.info(`[forgot-password] reset email sent to ${email}`);
        } catch (err) {
            logger.error('[forgot-password]', err.message);
        }
    });
});

app.post("/tenant/reset-password", async (req, res) => {
    const { token, new_password } = req.body;
    if (!token || !new_password)
        return res.status(400).json({ error: 'token and new_password are required' });
    if (new_password.length < 8)
        return res.status(400).json({ error: 'Password must be at least 8 characters' });

    try {
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        const record = getValidResetToken(tokenHash);

        if (!record) {
            return res.status(400).json({ error: 'Reset link is invalid or has expired. Please request a new one.' });
        }

        updateTenantPassword(record.tenant_id, new_password);
        markResetTokenUsed(tokenHash);

        res.json({ ok: true, message: 'Password reset successfully. You can now log in.' });
    } catch (err) {
        logger.error('[reset-password]', err.message);
        res.status(500).json({ error: 'Failed to reset password' });
    }
});

// ── Public — Plan listing for registration page ────────────────────────────────

app.get("/api/public/plans", (_req, res) => {
    try {
        const plans = getActivePlans();
        const safe = plans.map(p => ({
            id: p.id, name: p.name, description: p.description,
            price_cents: p.price_cents, billing_cycle: p.billing_cycle,
            max_services: p.max_services, whatsapp_access: p.whatsapp_access,
            instagram_access: p.instagram_access, facebook_access: p.facebook_access,
            ai_calls_access: p.ai_calls_access,
        }));
        res.json(safe);
    } catch (err) {
        logger.error('[public plans]', err.message);
        res.status(500).json({ error: 'Failed to load plans' });
    }
});

// ── Public — Stripe Checkout registration ─────────────────────────────────────

app.post("/api/register", async (req, res) => {
    if (rateLimit(`register:${req.ip}`, 5, 10 * 60_000))
        return res.status(429).json({ error: 'Too many registration attempts. Please try again in 10 minutes.' });

    const { owner_name, salon_name, email, phone, plan_id } = req.body;
    if (!owner_name || !salon_name || !email || !phone || !plan_id)
        return res.status(400).json({ error: 'owner_name, salon_name, email, phone, plan_id are required' });

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        return res.status(400).json({ error: 'Invalid email address' });

    if (!isValidPhone(phone))
        return res.status(400).json({ error: 'Invalid phone number (must be 8-15 digits, optional leading +).' });
    const normalizedRegPhone = normalizePhone(phone);

    const superDb = getSuperDb();
    const existing = superDb.prepare("SELECT id FROM salon_tenants WHERE email = ?").get(email);
    if (existing) return res.status(409).json({ error: 'An account with this email already exists' });

    const plan = getPlanById(parseInt(plan_id, 10));
    if (!plan || !plan.is_active)
        return res.status(404).json({ error: 'Plan not found or inactive' });

    // Free plan — create tenant directly
    if (plan.price_cents === 0) {
        try {
            const generatedPassword = crypto.randomBytes(8).toString('hex');
            const tenantId = await createTenant(owner_name, salon_name, email, normalizedRegPhone, generatedPassword);
            createSubscription(tenantId, plan.id, null, null, null, null);
            const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3002';
            sendWelcomeEmail({
                to: email, ownerName: owner_name, salonName: salon_name,
                email, password: generatedPassword, loginUrl: `${frontendUrl}/login`,
            }).catch(err => logger.warn('[welcome email free plan]', err.message));
            return res.json({ ok: true, redirect: `${frontendUrl}/login?registered=1` });
        } catch (err) {
            logger.error('[free register]', err.message);
            return res.status(500).json({ error: 'Registration failed' });
        }
    }

    // Paid plan
    if (!plan.stripe_price_id)
        return res.status(400).json({ error: 'This plan is not yet available for purchase. Please contact support.' });

    try {
        const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3002';
        const session = await createCheckoutSession({
            planId: plan.id,
            stripePriceId: plan.stripe_price_id,
            email, ownerName: owner_name, salonName: salon_name, phone: normalizedRegPhone,
          successUrl: `${frontendUrl}/register/success?session_id={CHECKOUT_SESSION_ID}`,
          cancelUrl: `${frontendUrl}/register?cancelled=1`,
        });
        res.json({ checkout_url: session.url });
    } catch (err) {
        logger.error('[stripe checkout]', err.message);
        res.status(500).json({ error: 'Payment initiation failed. Please try again.' });
    }
});

// ── Stripe Webhook ─────────────────────────────────────────────────────────────

app.post("/api/stripe/webhook", async (req, res) => {
  const signature = req.headers['stripe-signature'];
  if (!signature) {
    logger.warn('[stripe webhook] missing stripe-signature header, ignoring');
    return res.status(200).json({ received: true });
  }

  let event;
  try {
    event = constructWebhookEvent(req.body, signature);
  } catch (err) {
    logger.error('[stripe webhook] signature verification failed:', err.message);
    return res.status(200).json({ received: true });
  }

  const toIso = (ts) => (ts == null ? null : new Date(ts * 1000).toISOString());

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const meta = session.metadata || {};
    const email = session.customer_email || meta.email;
    const { owner_name, salon_name, phone, plan_id, tenantId, action, oldPlanId, newPlanId } = meta;

    // ✅ CHECK IF THIS IS AN UPGRADE
    const isUpgrade = action === 'upgrade' || meta.is_upgrade === 'true' || (tenantId && tenantId !== 'undefined' && tenantId !== 'none');

    if (isUpgrade && tenantId) {
      // ✅ THIS IS AN UPGRADE - Update existing subscription
      logger.info(`[stripe webhook] Processing UPGRADE for tenant: ${tenantId}`);

      try {
        // Extract period dates from subscription
        let _periodStart = null;
        let _periodEnd = null;
        const subId = typeof session.subscription === 'object'
          ? (session.subscription && session.subscription.id)
          : session.subscription;

        if (subId) {
          try {
            const now = new Date();
            _periodStart = now.toISOString();

            // Calculate end date from plan's billing cycle
            const planForDates = getPlanById(parseInt(newPlanId || plan_id, 10));
            if (planForDates) {
              const end = new Date(now);
              if (planForDates.billing_cycle === 'yearly') {
                end.setFullYear(end.getFullYear() + 1);
              } else {
                end.setMonth(end.getMonth() + 1);
              }
              _periodEnd = end.toISOString();
            }

            logger.info(`[stripe webhook] Calculated period on the fly: ${_periodStart} → ${_periodEnd}`);
          } catch (subErr) {
            logger.error(`Failed to calculate subscription period: ${subErr.message}`);
          }
        }

        // Update existing subscription with period dates
        const newPlanIdNum = parseInt(newPlanId || plan_id, 10);
        updateSubscriptionByTenantId(tenantId, {
          planId: newPlanIdNum,
          status: 'active',
          currentPeriodStart: _periodStart,
          currentPeriodEnd: _periodEnd,
        });

        // Apply service freeze/unfreeze
        const newPlan = getPlanById(newPlanIdNum);
        if (newPlan && newPlan.max_services !== undefined) {
          freezeExcessServices(tenantId, newPlan.max_services);
          unfreezeServices(tenantId, newPlan.max_services);
        }

        // Send upgrade confirmation email
        const tenant = getTenantById(tenantId);
        if (tenant) {
          const oldPlan = getPlanById(parseInt(oldPlanId || '0', 10));
          await sendPlanUpgradeEmail({
            to: tenant.email,
            ownerName: tenant.owner_name,
            salonName: tenant.salon_name,
            oldPlanName: oldPlan?.name || "Unknown",
            newPlanName: newPlan?.name || "Unknown",
            amount: `$${(newPlan?.price_cents || 0) / 100}`,
            billingCycle: newPlan?.billing_cycle || "monthly",
            nextBillingDate: _periodEnd ? new Date(_periodEnd).toLocaleDateString() : new Date().toLocaleDateString(),
          }).catch(err => logger.error("[email] upgrade error:", err.message));
        }

        logger.info(`[stripe webhook] Successfully upgraded tenant ${tenantId} to plan ${newPlanIdNum}`);
      } catch (err) {
        logger.error(`[stripe webhook] Upgrade failed for tenant ${tenantId}:`, err.message);
      }

      return res.json({ received: true });
    }

    // ✅ IF NOT AN UPGRADE, process as new registration
    if (!email || !owner_name || !salon_name) {
      logger.warn('[stripe webhook] missing metadata in session:', session.id);
      return res.json({ received: true });
    }

    // Idempotency: skip if tenant already exists
    const superDb = getSuperDb();
    const existing = superDb.prepare("SELECT id FROM salon_tenants WHERE email = ?").get(email);
    if (existing) {
      logger.info(`[stripe webhook] tenant already exists for ${email}, skipping`);
      return res.json({ received: true });
    }

    // Extract period dates for new registration
    let _periodStart = null;
    let _periodEnd = null;
    const subId = typeof session.subscription === 'object'
      ? (session.subscription && session.subscription.id)
      : session.subscription;
    if (subId) {
      try {
        const stripeSub = await retrieveSubscription(subId);
        _periodStart = toIso(stripeSub.current_period_start);
        _periodEnd = toIso(stripeSub.current_period_end);
        logger.info(`[stripe webhook] New registration subscription period: ${_periodStart} → ${_periodEnd}`);
      } catch (subErr) {
        logger.error(`[stripe webhook] failed to retrieve subscription ${subId}: ${subErr.message}`);
      }
    } else {
      logger.warn(`[stripe webhook] checkout.session.completed has no subscription ID`, session.id);
    }

    // Create tenant + subscription row for new registration
    const planIdNum = parseInt(plan_id || '0', 10);
    let newTenantId, generatedPassword;  // ✅ Changed variable name to avoid conflict
    try {
      generatedPassword = crypto.randomBytes(8).toString('hex');
      newTenantId = await createTenant(owner_name, salon_name, email, phone || '', generatedPassword);
      if (planIdNum) {
        createSubscription(newTenantId, planIdNum, subId || null,
          session.customer || null, _periodStart, _periodEnd);
      } else {
        logger.warn(`[stripe webhook] no valid plan_id in metadata for session ${session.id}, subscription not created`);
      }
      logger.info(`[stripe webhook] New tenant ${newTenantId} created for ${email} with plan ${planIdNum}`);
    } catch (err) {
      logger.error(`[stripe webhook] tenant creation error:`, err.message);
    }

    // Send welcome email
    if (newTenantId && generatedPassword) {
      setImmediate(async () => {
        try {
          const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3002';
          await sendWelcomeEmail({
            to: email, ownerName: owner_name, salonName: salon_name,
            email, password: generatedPassword, loginUrl: `${frontendUrl}/login`,
          });
        } catch (err) {
          logger.error(`[stripe webhook] welcome email error:`, err.message);
        }
      });
    }
  }
  else if (event.type === 'customer.subscription.created') {
    const sub = event.data.object;
    try {
      const superDb = getSuperDb();
      const existing = superDb.prepare('SELECT id FROM subscriptions WHERE stripe_subscription_id = ?').get(sub.id);
      if (existing) {
        updateSubscription(sub.id, {
          currentPeriodStart: toIso(sub.current_period_start),
          currentPeriodEnd: toIso(sub.current_period_end),
        });
        logger.info(`[stripe webhook] subscription.created: period dates written for ${sub.id}`);
      } else {
        logger.warn(`[stripe webhook] subscription.created: no DB row found for ${sub.id} (checkout.session.completed pending)`);
      }
    } catch (err) {
      logger.error(`[stripe webhook] subscription.created handler error:`, err.message);
    }
  }
  else if (event.type === 'customer.subscription.updated') {
    const sub = event.data.object;
    try {
      const superDb = getSuperDb();
      const row = superDb.prepare('SELECT tenant_id, plan_id FROM subscriptions WHERE stripe_subscription_id = ?').get(sub.id);
      if (!row) {
        logger.warn(`[stripe webhook] subscription.updated: no DB row found for ${sub.id}`);
      } else {
        let newPlanId;
        const stripePriceId = sub.items && sub.items.data && sub.items.data[0] && sub.items.data[0].price && sub.items.data[0].price.id;
        if (stripePriceId) {
          const planByPrice = superDb.prepare('SELECT id FROM plans WHERE stripe_price_id = ?').get(stripePriceId);
          if (planByPrice && planByPrice.id !== row.plan_id) newPlanId = planByPrice.id;
        }
        updateSubscription(sub.id, {
          planId: newPlanId,
          status: sub.status,
          currentPeriodStart: toIso(sub.current_period_start),
          currentPeriodEnd: toIso(sub.current_period_end),
        });

        // If plan changed, apply service freeze/unfreeze
        if (newPlanId) {
          const tenant = getTenantById(row.tenant_id);
          const newPlan = getPlanById(newPlanId);
          if (tenant && newPlan && newPlan.max_services !== undefined) {
            freezeExcessServices(row.tenant_id, newPlan.max_services);
            unfreezeServices(row.tenant_id, newPlan.max_services);
            logger.info(`[stripe webhook] Applied service limits for tenant ${row.tenant_id} (max_services=${newPlan.max_services})`);
          }
        }

        logger.info(`[stripe webhook] subscription.updated: ${sub.id} status=${sub.status}${newPlanId ? ` planId=${newPlanId}` : ''}`);
      }
    } catch (err) {
      logger.error(`[stripe webhook] subscription.updated handler error:`, err.message);
    }
  }
  else if (event.type === 'customer.subscription.deleted') {
    const sub = event.data.object;
    try {
      const cancellationDate = toIso(sub.canceled_at) || new Date().toISOString();
      cancelSubscription(sub.id, cancellationDate);
      logger.info(`[stripe webhook] subscription.deleted: ${sub.id} canceled at ${cancellationDate}`);
    } catch (err) {
      logger.error(`[stripe webhook] subscription.deleted handler error:`, err.message);
    }
  }

  res.json({ received: true });
});
// ─────────────────────────────────────────────────────────────────────────────
//  Salon Admin — Auth
// ─────────────────────────────────────────────────────────────────────────────

// Login page
app.get("/salon-admin/login", (_req, res) => {
  res.sendFile(path.join(__dirname, "admin/views/salon-login.html"));
});

// Login POST (JSON — called by frontend fetch)
app.post("/salon-admin/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: "email and password required" });

  if (rateLimit(`login:tenant:${email}`, 5, 15 * 60_000))
    return res.status(429).json({ error: "Too many login attempts. Try again in 15 minutes." });

  const tenant = authenticateTenant(email, password);
  if (!tenant)
    return res.status(401).json({ error: "Invalid credentials" });

  const token = generateTenantToken(tenant);
  res.cookie("tenantToken", token, { httpOnly: true, maxAge: 604_800_000, path: "/" });
  res.json({ success: true, redirect: "/salon-admin/dashboard" });
});

// Dashboard
app.get("/salon-admin/dashboard", requireTenantAuth, (_req, res) => {
  res.sendFile(path.join(__dirname, "admin/views/panel.html"));
});

// Change own password
app.put("/salon-admin/api/change-password", requireTenantAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword)
    return res.status(400).json({ error: "currentPassword and newPassword required" });
  if (newPassword.length < 6)
    return res.status(400).json({ error: "New password must be at least 6 characters" });

  const superDb = getSuperDb();
  const tenant = superDb.prepare("SELECT * FROM salon_tenants WHERE tenant_id = ?").get(req.tenantId);
  if (!tenant) return res.status(404).json({ error: "Tenant not found" });

  if (!bcrypt.compareSync(currentPassword, tenant.password_hash))
    return res.status(401).json({ error: "Current password is incorrect" });

  updateTenantPassword(req.tenantId, newPassword);
  res.json({ ok: true });
});

// Logout
app.get("/salon-admin/logout", (_req, res) => {
  res.clearCookie("tenantToken");
  res.redirect("/salon-admin/login");
});

// ─────────────────────────────────────────────────────────────────────────────
//  Salon Admin — Stats
// ─────────────────────────────────────────────────────────────────────────────

app.get("/salon-admin/api/stats", requireTenantAuth, (req, res) => {
  const tenantId = req.tenantId;
  const db = getDb();

  // ✅ FIX: Accept optional tz param. If provided, compute today in that timezone.
  // Falls back to UTC. Format: YYYY-MM-DD for SQL date comparison.
  const tz = req.query.tz || "UTC";
  let today;
  try {
    today = new Date().toLocaleDateString("en-CA", { timeZone: tz }); // YYYY-MM-DD in salon TZ
  } catch {
    today = new Date().toISOString().slice(0, 10);
  }

  const serverTime = new Date().toISOString();

  res.json({
    total_bookings:  db.prepare(`SELECT COUNT(*) AS n FROM ${tenantId}_bookings WHERE status != 'archived'`).get().n,
    today_bookings:  db.prepare(`SELECT COUNT(*) AS n FROM ${tenantId}_bookings WHERE date = ? AND status NOT IN ('archived','canceled')`).get(today).n,
    active_services: db.prepare(`SELECT COUNT(*) AS n FROM ${tenantId}_services`).get().n,
    total_clients:   db.prepare(`SELECT COUNT(DISTINCT phone) AS n FROM ${tenantId}_bookings WHERE status != 'archived'`).get().n,
    // ✅ Metadata: frontend can verify what "today" was computed as
    queryRange: { start: today, end: today, tz },
    dataFreshAsOf: serverTime,
    serverTime,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Salon Admin — Deals
// ─────────────────────────────────────────────────────────────────────────────

// GET all services
app.get("/salon-admin/api/services", requireTenantAuth, (req, res) => {
  const tenantId = req.tenantId;
  const db = getDb();
  try {
    const services = db.prepare(`SELECT * FROM ${tenantId}_services ORDER BY branch, name`).all();
    res.json(services);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// CREATE single service
app.post("/salon-admin/api/services", requireTenantAuth, (req, res) => {
  const tenantId = req.tenantId;
  const { name, price, description, branch, durationMinutes } = req.body;
  const db = getDb();

  const errs = [];
  if (!name?.trim()) errs.push("name");
  if (!price) errs.push("price");
  if (!branch) errs.push("branch");
  if (!durationMinutes) errs.push("durationMinutes");

  if (errs.length) {
    return res.status(400).json({ error: `Missing/invalid: ${errs.join(", ")}` });
  }

  try {
    const sub = getTenantSubscription(tenantId);
    if (sub) {
      // PLN-01: count only non-frozen services against the plan limit
      const currentCount = db.prepare(`SELECT COUNT(*) as cnt FROM ${tenantId}_services WHERE frozen = 0`).get().cnt;
      if (currentCount >= sub.max_services) {
        return res.status(403).json({
          ok: false,
          error: `Service limit reached for your plan (max ${sub.max_services})`,
        });
      }
    }

    const r = db.prepare(`
      INSERT INTO ${tenantId}_services (name, price, description, branch, durationMinutes, updated_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
    `).run(name.trim(), price, description || null, branch.trim(), parseInt(durationMinutes));

    const newService = db.prepare(`SELECT * FROM ${tenantId}_services WHERE id = ?`).get(r.lastInsertRowid);

    // Update cache
    const updated = db.prepare(`SELECT * FROM ${tenantId}_services ORDER BY branch, name`).all();
    patchCache(tenantId, "services", "replace", updated).catch((e) =>
      logger.error("[cache] services create:", e.message)
    );

    res.json(newService);
  } catch (err) {
    logger.error("[admin] Create service error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// UPDATE single service
app.put("/salon-admin/api/services/:id", requireTenantAuth, (req, res) => {
  const tenantId = req.tenantId;
  const serviceId = req.params.id;
  const { name, price, description, branch, durationMinutes } = req.body;
  const db = getDb();

  const errs = [];
  if (!name?.trim()) errs.push("name");
  if (!price) errs.push("price");
  if (!branch) errs.push("branch");
  if (!durationMinutes) errs.push("durationMinutes");

  if (errs.length) {
    return res.status(400).json({ error: `Missing/invalid: ${errs.join(", ")}` });
  }

  const existing = db.prepare(`SELECT * FROM ${tenantId}_services WHERE id = ?`).get(serviceId);
  if (!existing) {
    return res.status(404).json({ error: "Service not found" });
  }

  try {
    db.prepare(`
      UPDATE ${tenantId}_services 
      SET name = ?, price = ?, description = ?, branch = ?, durationMinutes = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(name.trim(), price, description || null, branch.trim(), parseInt(durationMinutes), serviceId);

    const updated = db.prepare(`SELECT * FROM ${tenantId}_services WHERE id = ?`).get(serviceId);

    // Update cache
    const allServices = db.prepare(`SELECT * FROM ${tenantId}_services ORDER BY branch, name`).all();
    patchCache(tenantId, "services", "replace", allServices).catch((e) =>
      logger.error("[cache] services update:", e.message)
    );

    res.json(updated);
  } catch (err) {
    logger.error("[admin] Update service error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE service
app.delete("/salon-admin/api/services/:id", requireTenantAuth, (req, res) => {
  const tenantId = req.tenantId;
  const serviceId = req.params.id;
  const db = getDb();

  const existing = db.prepare(`SELECT * FROM ${tenantId}_services WHERE id = ?`).get(serviceId);
  if (!existing) {
    return res.status(404).json({ error: "Service not found" });
  }

  try {
    db.prepare(`DELETE FROM ${tenantId}_services WHERE id = ?`).run(serviceId);

    // Update cache
    const updated = db.prepare(`SELECT * FROM ${tenantId}_services ORDER BY branch, name`).all();
    patchCache(tenantId, "services", "replace", updated).catch((e) =>
      logger.error("[cache] services delete:", e.message)
    );

    res.json({ ok: true });
  } catch (err) {
    logger.error("[admin] Delete service error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET all deals
app.get("/salon-admin/api/deals", requireTenantAuth, (req, res) => {
  const tenantId = req.tenantId;
  const db = getDb();
  try {
    const deals = db.prepare(`SELECT * FROM ${tenantId}_deals ORDER BY id`).all();
    res.json(deals);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// CREATE single deal
app.post("/salon-admin/api/deals", requireTenantAuth, (req, res) => {
  const tenantId = req.tenantId;
  const { title, description, active, off } = req.body;
  const db = getDb();

  if (!title?.trim()) {
    return res.status(400).json({ error: "Title is required" });
  }

  const offVal = Number.isInteger(Number(off)) ? Math.min(100, Math.max(0, Number(off))) : 0;

  try {
    const r = db.prepare(`
      INSERT INTO ${tenantId}_deals (title, description, active, off, updated_at)
      VALUES (?, ?, ?, ?, datetime('now'))
    `).run(title.trim(), description || null, active ? 1 : 0, offVal);

    const newDeal = db.prepare(`SELECT * FROM ${tenantId}_deals WHERE id = ?`).get(r.lastInsertRowid);

    // Update cache
    const updated = db.prepare(`SELECT * FROM ${tenantId}_deals ORDER BY id`).all();
    patchCache(tenantId, "deals", "replace", updated).catch((e) =>
      logger.error("[cache] deals create:", e.message)
    );

    res.json(newDeal);
  } catch (err) {
    logger.error("[admin] Create deal error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// UPDATE single deal
app.put("/salon-admin/api/deals/:id", requireTenantAuth, (req, res) => {
  const tenantId = req.tenantId;
  const dealId = req.params.id;
  const { title, description, active, off } = req.body;
  const db = getDb();

  if (!title?.trim()) {
    return res.status(400).json({ error: "Title is required" });
  }

  const offVal = Number.isInteger(Number(off)) ? Math.min(100, Math.max(0, Number(off))) : 0;

  const existing = db.prepare(`SELECT * FROM ${tenantId}_deals WHERE id = ?`).get(dealId);
  if (!existing) {
    return res.status(404).json({ error: "Deal not found" });
  }

  try {
    db.prepare(`
      UPDATE ${tenantId}_deals
      SET title = ?, description = ?, active = ?, off = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(title.trim(), description || null, active ? 1 : 0, offVal, dealId);

    const updated = db.prepare(`SELECT * FROM ${tenantId}_deals WHERE id = ?`).get(dealId);

    // Update cache
    const allDeals = db.prepare(`SELECT * FROM ${tenantId}_deals ORDER BY id`).all();
    patchCache(tenantId, "deals", "replace", allDeals).catch((e) =>
      logger.error("[cache] deals update:", e.message)
    );

    res.json(updated);
  } catch (err) {
    logger.error("[admin] Update deal error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE deal
app.delete("/salon-admin/api/deals/:id", requireTenantAuth, (req, res) => {
  const tenantId = req.tenantId;
  const dealId = req.params.id;
  const db = getDb();

  const existing = db.prepare(`SELECT * FROM ${tenantId}_deals WHERE id = ?`).get(dealId);
  if (!existing) {
    return res.status(404).json({ error: "Deal not found" });
  }

  try {
    db.prepare(`DELETE FROM ${tenantId}_deals WHERE id = ?`).run(dealId);

    // Update cache
    const updated = db.prepare(`SELECT * FROM ${tenantId}_deals ORDER BY id`).all();
    patchCache(tenantId, "deals", "replace", updated).catch((e) =>
      logger.error("[cache] deals delete:", e.message)
    );

    res.json({ ok: true });
  } catch (err) {
    logger.error("[admin] Delete deal error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  Salon Admin — Bookings (CRUD)
// ─────────────────────────────────────────────────────────────────────────────

app.get("/salon-admin/api/bookings", requireTenantAuth, (req, res) => {
  const tenantId = req.tenantId;
  let sql = `SELECT * FROM ${tenantId}_bookings WHERE 1=1`;
  const args = [];

  if (req.query.date) { sql += " AND date = ?"; args.push(req.query.date); }
  if (req.query.status) { sql += " AND status = ?"; args.push(req.query.status); }
  sql += " ORDER BY created_at DESC";
  if (req.query.limit) { sql += " LIMIT ?"; args.push(parseInt(req.query.limit)); }

  // Use cache only for unfiltered requests
  if (!req.query.date && !req.query.status && !req.query.limit) {
    const cache = getCache(tenantId);
    if (cache?.bookings) return res.json(cache.bookings);
  }

  const bookings = getDb().prepare(sql).all(...args);
  res.json(bookings);
});

app.post("/salon-admin/api/bookings", requireTenantAuth, (req, res) => {
  const tenantId = req.tenantId;
  const db = getDb();
  let { customer_name, phone, service, branch, date, time, notes, staff_id, staff_name } = req.body;

  // Normalize staff_id: empty string / "0" / 0 / null → null
  staff_id = (staff_id && staff_id !== "0") ? (parseInt(staff_id, 10) || null) : null;

  const errs = validateBookingBody(req.body);
  if (errs.length)
    return res.status(400).json({ ok: false, error: `Missing/invalid: ${errs.join(", ")}` });

  const staffBranchErr = checkStaffBranch(staff_id, branch.trim(), db, tenantId);
  if (staffBranchErr) return res.status(400).json({ ok: false, error: staffBranchErr });

  const duration = getServiceDuration(service.trim(), db, tenantId);
  const endTime = calculateEndTime(time.trim(), duration);

  const timingErr = checkBookingTimingWithEndTime(date.trim(), time.trim(), endTime, db, tenantId);
  if (timingErr) return res.status(400).json({ ok: false, error: timingErr });

  // Admin panel bookings are never customer requests — only bot bookings set staffRequested=1
  var staffRequested = 0;

  if (staff_id) {
    const availErr = checkStaffAvailability(staff_id, date.trim(), time.trim(), endTime, db, tenantId);
    if (availErr) return res.status(400).json({ ok: false, error: availErr });
  } else {
    const available = findAvailableStaff(date.trim(), time.trim(), endTime, branch.trim(), db, tenantId);
    if (available.length > 0) {
      const picked = available[Math.floor(Math.random() * available.length)];
      staff_id = picked.id;
      staff_name = picked.name;
      staffRequested = 0;
    }
  }

  const r = db.prepare(`
    INSERT INTO ${tenantId}_bookings
      (customer_name, phone, service, branch, date, time, endTime, notes, status, source, staff_id, staff_name, staffRequested)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', 'manual', ?, ?, ?)
  `).run(
    customer_name.trim(), (normalizePhone(phone) || phone.trim()), service.trim(), branch.trim(),
    date.trim(), time.trim(), endTime, notes || null,
    staff_id || null, staff_name || null, staffRequested
  );

  const newBooking = db.prepare(`SELECT * FROM ${tenantId}_bookings WHERE id = ?`).get(r.lastInsertRowid);

  if (staff_id && newBooking) {
    const branchRow = db.prepare(`SELECT id FROM ${tenantId}_branches WHERE name = ?`).get(branch.trim());
    try {
      db.prepare(`
        INSERT INTO ${tenantId}_staff_bookings (staffId, bookingId, branchId, startTime, endTime, status)
        VALUES (?, ?, ?, ?, ?, 'active')
      `).run(staff_id, newBooking.id, branchRow?.id || null, `${date.trim()} ${time.trim()}`, `${date.trim()} ${endTime}`);
    } catch (e) { logger.error("[booking] staff_bookings insert:", e.message); }
  }

  patchCache(tenantId, "bookings", "upsert", newBooking).catch((e) =>
    logger.error("[cache] bookings upsert:", e.message)
  );
  res.json(newBooking);
});

app.put("/salon-admin/api/bookings/:id", requireTenantAuth, (req, res) => {
  const tenantId = req.tenantId;
  const bookingId = req.params.id;
  const db = getDb();
  let { customer_name, phone, service, branch, date, time, notes, staff_id, staff_name, status } = req.body;

  // Normalize staff_id: empty string / "0" / 0 / null → null
  staff_id = (staff_id && staff_id !== "0") ? (parseInt(staff_id, 10) || null) : null;

  const errs = validateBookingBody(req.body, true);
  if (errs.length)
    return res.status(400).json({ ok: false, error: `Missing/invalid: ${errs.join(", ")}` });

  const staffBranchErr = checkStaffBranch(staff_id, branch.trim(), db, tenantId);
  if (staffBranchErr) return res.status(400).json({ ok: false, error: staffBranchErr });

  const duration = getServiceDuration(service.trim(), db, tenantId);
  const endTime = calculateEndTime(time.trim(), duration);

  const timingErr = checkBookingTimingWithEndTime(date.trim(), time.trim(), endTime, db, tenantId);
  if (timingErr) return res.status(400).json({ ok: false, error: timingErr });

  // Admin panel bookings are never customer requests — preserve existing staffRequested from DB
  const existingBooking = db.prepare(`SELECT staffRequested FROM ${tenantId}_bookings WHERE id = ?`).get(bookingId);
  let staffRequested = existingBooking?.staffRequested ?? 0;

  if (staff_id) {
    // Pass excludeBookingId so the existing booking doesn't conflict with itself
    const availErr = checkStaffAvailability(staff_id, date.trim(), time.trim(), endTime, db, tenantId, bookingId);
    if (availErr) return res.status(400).json({ ok: false, error: availErr });
  } else {
    const available = findAvailableStaff(date.trim(), time.trim(), endTime, branch.trim(), db, tenantId);
    if (available.length > 0) {
      const picked = available[Math.floor(Math.random() * available.length)];
      staff_id = picked.id;
      staff_name = picked.name;
      staffRequested = 0;
    }
  }

  db.prepare(`
    UPDATE ${tenantId}_bookings
    SET customer_name=?, phone=?, service=?, branch=?, date=?, time=?, endTime=?,
        notes=?, status=?, staff_id=?, staff_name=?, staffRequested=?, updated_at=datetime('now')
    WHERE id=?
  `).run(
    customer_name.trim(), (normalizePhone(phone) || phone.trim()), service.trim(), branch.trim(),
    date.trim(), time.trim(), endTime, notes || null,
    status || "confirmed", staff_id || null, staff_name || null, staffRequested,
    bookingId
  );

  // Refresh staff_bookings link
  db.prepare(`DELETE FROM ${tenantId}_staff_bookings WHERE bookingId = ?`).run(bookingId);
  if (staff_id) {
    const branchRow = db.prepare(`SELECT id FROM ${tenantId}_branches WHERE name = ?`).get(branch.trim());
    try {
      db.prepare(`
        INSERT INTO ${tenantId}_staff_bookings (staffId, bookingId, branchId, startTime, endTime, status)
        VALUES (?, ?, ?, ?, ?, 'active')
      `).run(staff_id, bookingId, branchRow?.id || null, `${date.trim()} ${time.trim()}`, `${date.trim()} ${endTime}`);
    } catch (e) { logger.error("[booking] staff_bookings insert:", e.message); }
  }

  const updated = db.prepare(`SELECT * FROM ${tenantId}_bookings WHERE id = ?`).get(bookingId);
  if (updated)
    patchCache(tenantId, "bookings", "upsert", updated).catch((e) =>
      logger.error("[cache] bookings put:", e.message)
    );
  res.json({ ok: true });
});

app.patch("/salon-admin/api/bookings/:id/status", requireTenantAuth, (req, res) => {
  const tenantId = req.tenantId;
  const bookingId = req.params.id;
  const db = getDb();
  const newStatus = (req.body.status || "").toLowerCase();

  const VALID_STATUSES = ["confirmed", "canceled", "completed", "no_show", "arrived"];
  if (!VALID_STATUSES.includes(newStatus))
    return res.status(400).json({ ok: false, error: `Status must be one of: ${VALID_STATUSES.join(", ")}` });

  const current = db.prepare(`SELECT * FROM ${tenantId}_bookings WHERE id = ?`).get(bookingId);
  if (!current) return res.status(404).json({ ok: false, error: "Booking not found" });

  const transitionErr = validateStatusTransition(current.status, newStatus);
  if (transitionErr) return res.status(400).json({ ok: false, error: transitionErr });

  db.prepare(`UPDATE ${tenantId}_bookings SET status=?, updated_at=datetime('now') WHERE id=?`)
    .run(newStatus, bookingId);

  if (["canceled", "no_show", "completed", "arrived"].includes(newStatus))
    db.prepare(`UPDATE ${tenantId}_staff_bookings SET status=?, updated_at=datetime('now') WHERE bookingId=?`)
      .run(newStatus, bookingId);

  // Track metrics for completed bookings
  if (newStatus === "completed") {
    db.prepare(`
      INSERT INTO ${tenantId}_customer_metrics (phone, total_bookings, completed) VALUES (?, 1, 1)
      ON CONFLICT(phone) DO UPDATE SET completed = completed + 1, last_visit = ?, updated_at = datetime('now')
    `).run(current.phone, current.date);
    db.prepare(`
      INSERT INTO ${tenantId}_booking_audit (booking_id, old_status, new_status, changed_by, reason)
      VALUES (?, ?, 'completed', 'admin', 'Marked as completed via admin panel')
    `).run(bookingId, current.status);
  }

  if (newStatus === "canceled") {
    db.prepare(`
      INSERT INTO ${tenantId}_booking_audit (booking_id, old_status, new_status, changed_by, reason)
      VALUES (?, ?, 'canceled', 'admin', ?)
    `).run(bookingId, current.status, req.body.reason || "Canceled via admin panel");
  }

  if (newStatus === "arrived") {
    db.prepare(`
      INSERT INTO ${tenantId}_booking_audit (booking_id, old_status, new_status, changed_by, reason)
      VALUES (?, ?, 'arrived', 'admin', 'Marked as arrived via admin panel')
    `).run(bookingId, current.status);
  }

  const updated = db.prepare(`SELECT * FROM ${tenantId}_bookings WHERE id = ?`).get(bookingId);
  if (updated)
    patchCache(tenantId, "bookings", "upsert", updated).catch((e) =>
      logger.error("[cache] bookings status patch:", e.message)
    );
  res.json({ ok: true });
});

// POST /salon-admin/api/invoices
//   Body: { booking_id, extra_services_price, tips, deal_ids: number[], payment_type }
//   Creates an invoice, transitions booking status arrived→completed, returns the inserted row.
//   Idempotency: UNIQUE(booking_id) constraint — returns 409 on duplicate.
app.post("/salon-admin/api/invoices", requireTenantAuth, (req, res) => {
  const tenantId = req.tenantId;
  const db = getDb();
  const {
    booking_id,
    extra_services_price = 0,
    tips = 0,
    deal_ids = [],
    payment_type,
  } = req.body || {};

  const errs = [];
  if (!Number.isInteger(booking_id) || booking_id <= 0) errs.push("booking_id required (integer)");
  const extras = Number(extra_services_price);
  const tipsNum = Number(tips);
  if (!Number.isFinite(extras) || extras < 0) errs.push("extra_services_price must be >= 0");
  if (!Number.isFinite(tipsNum) || tipsNum < 0) errs.push("tips must be >= 0");
  if (!Array.isArray(deal_ids) || deal_ids.some(d => !Number.isInteger(d))) errs.push("deal_ids must be integer array");
  const VALID_PAY = ["cash", "card", "bank_to_bank"];
  if (!VALID_PAY.includes(payment_type)) errs.push(`payment_type must be one of: ${VALID_PAY.join(", ")}`);
  if (errs.length) return res.status(400).json({ ok: false, error: errs.join("; ") });

  const booking = db.prepare(`SELECT * FROM ${tenantId}_bookings WHERE id = ?`).get(booking_id);
  if (!booking) return res.status(404).json({ ok: false, error: "Booking not found" });
  if (booking.status !== "arrived") {
    return res.status(400).json({ ok: false, error: `Invoice can only be generated for arrived bookings (current: ${booking.status})` });
  }

  const existing = db.prepare(`SELECT id FROM ${tenantId}_invoices WHERE booking_id = ?`).get(booking_id);
  if (existing) return res.status(409).json({ ok: false, error: "Invoice already exists for this booking" });

  // Resolve service price from services table (TEXT → number)
  const svcRow = db.prepare(`SELECT price FROM ${tenantId}_services WHERE name = ?`).get(booking.service);
  const servicePrice = parseFloat(String(svcRow?.price || "0").replace(/[^0-9.]/g, "")) || 0;

  // Resolve deals (must be active + valid off %)
  let dealsOffPct = 0;
  if (deal_ids.length > 0) {
    const placeholders = deal_ids.map(() => "?").join(",");
    const rows = db.prepare(`SELECT id, off FROM ${tenantId}_deals WHERE id IN (${placeholders}) AND active = 1`).all(...deal_ids);
    dealsOffPct = Math.min(100, rows.reduce((s, d) => s + (Number(d.off) || 0), 0));
  }
  const discountAmount = servicePrice * (dealsOffPct / 100);
  const total = (servicePrice - discountAmount) + extras + tipsNum;

  try {
    const result = db.transaction(() => {
      const ins = db.prepare(`
        INSERT INTO ${tenantId}_invoices
          (booking_id, customer_name, phone, service, branch, staff_id, staff_name,
           service_price, extra_services_price, tips, deal_ids_json, deals_off_pct,
           discount_amount, total, payment_type)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        booking_id, booking.customer_name, booking.phone, booking.service, booking.branch,
        booking.staff_id || null, booking.staff_name || null,
        servicePrice, extras, tipsNum, JSON.stringify(deal_ids), dealsOffPct,
        discountAmount, total, payment_type
      );
      db.prepare(`UPDATE ${tenantId}_bookings SET status='completed', updated_at=datetime('now') WHERE id=?`).run(booking_id);
      db.prepare(`UPDATE ${tenantId}_staff_bookings SET status='completed', updated_at=datetime('now') WHERE bookingId=?`).run(booking_id);
      db.prepare(`
        INSERT INTO ${tenantId}_booking_audit (booking_id, old_status, new_status, changed_by, reason)
        VALUES (?, 'arrived', 'completed', 'admin', 'Invoice generated')
      `).run(booking_id);
      db.prepare(`
        INSERT INTO ${tenantId}_customer_metrics (phone, total_bookings, completed, total_spent) VALUES (?, 1, 1, ?)
        ON CONFLICT(phone) DO UPDATE SET completed = completed + 1, total_spent = total_spent + ?, last_visit = ?, updated_at = datetime('now')
      `).run(booking.phone, Math.round(total), Math.round(total), booking.date);
      return ins.lastInsertRowid;
    })();
    const row = db.prepare(`SELECT * FROM ${tenantId}_invoices WHERE id = ?`).get(result);
    const updatedBooking = db.prepare(`SELECT * FROM ${tenantId}_bookings WHERE id = ?`).get(booking_id);
    if (updatedBooking) patchCache(tenantId, "bookings", "upsert", updatedBooking).catch((e) => logger.error("[invoices] cache booking:", e.message));
    res.json(row);
  } catch (err) {
    logger.error("[invoices] POST failed:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /salon-admin/api/invoices?from=&to=&branch=
app.get("/salon-admin/api/invoices", requireTenantAuth, (req, res) => {
  const tenantId = req.tenantId;
  const db = getDb();
  const { from, to, branch } = req.query;
  let sql = `SELECT i.*, b.date AS booking_date, b.time AS booking_time
             FROM ${tenantId}_invoices i
             LEFT JOIN ${tenantId}_bookings b ON i.booking_id = b.id
             WHERE 1=1`;
  const args = [];
  if (from) { sql += ` AND b.date >= ?`; args.push(from); }
  if (to) { sql += ` AND b.date <= ?`; args.push(to); }
  if (branch && branch !== "all") { sql += ` AND i.branch = ?`; args.push(branch); }
  sql += ` ORDER BY i.created_at DESC`;
  try {
    const rows = db.prepare(sql).all(...args);
    res.json(rows);
  } catch (err) {
    logger.error("[invoices] GET failed:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /salon-admin/api/invoices/:id — single invoice by id (used by reports click-to-view)
app.get("/salon-admin/api/invoices/:id", requireTenantAuth, (req, res) => {
  const tenantId = req.tenantId;
  const db = getDb();
  try {
    const row = db.prepare(`
      SELECT i.*, br.address AS branch_address, br.phone AS branch_phone
      FROM ${tenantId}_invoices i
      LEFT JOIN ${tenantId}_branches br ON br.name = i.branch
      WHERE i.id = ?
    `).get(Number(req.params.id));
    if (!row) return res.status(404).json({ ok: false, error: "Invoice not found" });
    res.json(row);
  } catch (err) {
    logger.error("[invoices] GET :id failed:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /salon-admin/api/staff/income?month=YYYY-MM  (defaults to current month, UTC)
// Returns per-staff tips total for the given month from the invoices table.
app.get("/salon-admin/api/staff/income", requireTenantAuth, (req, res) => {
  const tenantId = req.tenantId;
  const db = getDb();
  const month = (req.query.month && /^\d{4}-\d{2}$/.test(req.query.month))
    ? req.query.month
    : new Date().toISOString().slice(0, 7);
  const monthStart = `${month}-01`;
  const [y, m] = month.split("-").map(Number);
  const nextM = m === 12
    ? `${y + 1}-01-01`
    : `${y}-${String(m + 1).padStart(2, "0")}-01`;
  try {
    const rows = db.prepare(`
      SELECT st.id AS staff_id, st.name AS staff_name,
             COALESCE(SUM(i.tips), 0) AS tips_total,
             COUNT(i.id) AS invoice_count
      FROM ${tenantId}_staff st
      LEFT JOIN ${tenantId}_invoices i
        ON i.staff_id = st.id
       AND i.created_at >= ?
       AND i.created_at < ?
      GROUP BY st.id, st.name
      ORDER BY tips_total DESC, st.name ASC
    `).all(monthStart, nextM);
    res.json({ month, rows });
  } catch (err) {
    logger.error("[staff/income] failed:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.patch("/salon-admin/api/bookings/:id/no-show", requireTenantAuth, async (req, res) => {
  const tenantId = req.tenantId;
  const bookingId = req.params.id;
  const db = getDb();

  const booking = db.prepare(`SELECT * FROM ${tenantId}_bookings WHERE id = ?`).get(bookingId);
  if (!booking) return res.status(404).json({ ok: false, error: "Booking not found" });
  if (booking.status !== "confirmed")
    return res.status(400).json({ ok: false, error: "Only confirmed bookings can be marked as no-show" });

  db.prepare(`UPDATE ${tenantId}_bookings SET status='no_show', updated_at=datetime('now') WHERE id=?`).run(bookingId);
  db.prepare(`UPDATE ${tenantId}_staff_bookings SET status='no_show', updated_at=datetime('now') WHERE bookingId=?`).run(bookingId);
  db.prepare(`
    INSERT INTO ${tenantId}_customer_metrics (phone, total_bookings, no_shows)
    VALUES (?, 1, 1)
    ON CONFLICT(phone) DO UPDATE SET no_shows = no_shows + 1, updated_at = datetime('now')
  `).run(booking.phone);
  db.prepare(`
    INSERT INTO ${tenantId}_booking_audit (booking_id, old_status, new_status, changed_by, reason)
    VALUES (?, 'confirmed', 'no_show', 'admin', 'Manually marked as no-show')
  `).run(bookingId);

  const updated = db.prepare(`SELECT * FROM ${tenantId}_bookings WHERE id = ?`).get(bookingId);
  await patchCache(tenantId, "bookings", "upsert", updated).catch((e) =>
    logger.error("[cache] no-show:", e.message)
  );
  res.json({ ok: true });
});

// Soft-delete: archive instead of physical delete so history is preserved
app.delete("/salon-admin/api/bookings/:id", requireTenantAuth, (req, res) => {
  const tenantId = req.tenantId;
  const bookingId = req.params.id;
  const db = getDb();

  const booking = db.prepare(`SELECT * FROM ${tenantId}_bookings WHERE id = ?`).get(bookingId);
  if (!booking) return res.status(404).json({ ok: false, error: "Booking not found" });

  db.prepare(`UPDATE ${tenantId}_bookings SET status='archived', updated_at=datetime('now') WHERE id=?`)
    .run(bookingId);
  db.prepare(`UPDATE ${tenantId}_staff_bookings SET status='archived', updated_at=datetime('now') WHERE bookingId=?`)
    .run(bookingId);
  db.prepare(`
    INSERT INTO ${tenantId}_booking_audit (booking_id, old_status, new_status, changed_by, reason)
    VALUES (?, ?, 'archived', 'admin', 'Soft-deleted via admin panel')
  `).run(bookingId, booking.status);

  const updated = db.prepare(`SELECT * FROM ${tenantId}_bookings WHERE id = ?`).get(bookingId);
  patchCache(tenantId, "bookings", "upsert", updated).catch((e) =>
    logger.error("[cache] bookings archive:", e.message)
  );
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Salon Admin — Analytics Clients (clients with their booked services)
//  GET /salon-admin/api/analytics/clients?branch=&period=week&from=&to=&status=completed&tz=Asia/Karachi
// ─────────────────────────────────────────────────────────────────────────────

app.get("/salon-admin/api/analytics/clients", requireTenantAuth, (req, res) => {
  const tenantId = req.tenantId;
  const db = getDb();
  const { branch, from, to, status = "completed", period, tz = "UTC", source = "bookings" } = req.query;

  const statuses = status.split(",").map((s) => s.trim()).filter(Boolean);

  // Compute date range from period using salon timezone
  let rangeFrom = from || null;
  let rangeTo = to || null;
  const serverTime = new Date().toISOString();

  if (period && !from && !to) {
    try {
      const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: tz });

      if (period === "day") {
        rangeFrom = todayStr;
        rangeTo = todayStr;
      } else if (period === "week") {
        const d = new Date(todayStr);
        d.setDate(d.getDate() - d.getDay());
        rangeFrom = d.toISOString().slice(0, 10);
        rangeTo = todayStr;
      } else if (period === "month") {
        rangeFrom = todayStr.slice(0, 7) + "-01";
        rangeTo = todayStr;
      } else if (period === "year") {
        rangeFrom = todayStr.slice(0, 4) + "-01-01";
        rangeTo = todayStr;
      }
    } catch {
      // period ignored if tz is invalid
    }
  }

  // Group by client (phone as unique key)
  const clientMap = new Map();

  if (source === "invoices") {
    // Invoice-sourced client rollup: only clients who have been invoiced appear.
    // totalSpent / revenue excludes tips (tips belong to staff, not salon revenue).
    let sql = `SELECT i.id AS invoice_id, i.booking_id, i.customer_name, i.phone,
                      i.service, i.branch, i.staff_name,
                      i.total, i.tips, i.service_price,
                      i.extra_services_price, i.deals_off_pct, i.discount_amount,
                      i.payment_type, i.created_at
               FROM ${tenantId}_invoices i
               WHERE 1=1`;
    const args = [];
    if (branch && branch !== "all") { sql += " AND i.branch = ?"; args.push(branch); }
    if (rangeFrom) { sql += " AND DATE(i.created_at) >= ?"; args.push(rangeFrom); }
    if (rangeTo)   { sql += " AND DATE(i.created_at) <= ?"; args.push(rangeTo); }
    sql += " ORDER BY i.created_at DESC";
    const invoices = db.prepare(sql).all(...args);

    for (const inv of invoices) {
      const key = inv.phone || `__name_${inv.customer_name}`;
      const dateOnly = (inv.created_at || "").slice(0, 10);
      const tips = Number(inv.tips) || 0;
      const net = (Number(inv.total) || 0) - tips;

      if (!clientMap.has(key)) {
        clientMap.set(key, {
          customer_name: inv.customer_name,
          phone: inv.phone || null,
          services: [],
          bookings: [],
          totalBookings: 0,
          totalSpent: 0,
          lastVisit: dateOnly,
          firstVisit: dateOnly,
          branches: new Set(),
        });
      }

      const client = clientMap.get(key);

      const existingSvc = client.services.find(s => s.name === inv.service);
      if (existingSvc) {
        existingSvc.count++;
        existingSvc.revenue += net;
      } else {
        client.services.push({ name: inv.service, count: 1, revenue: net });
      }

      client.bookings.push({
        date: dateOnly,
        time: "",
        service: inv.service,
        branch: inv.branch,
        staff_name: inv.staff_name,
        price: net,
        invoice_id: inv.invoice_id,
        booking_id: inv.booking_id,
      });

      client.totalBookings++;
      client.totalSpent += net;
      if (dateOnly > client.lastVisit) client.lastVisit = dateOnly;
      if (dateOnly < client.firstVisit) client.firstVisit = dateOnly;
      if (inv.branch) client.branches.add(inv.branch);
    }
  } else {
    // Default: bookings-sourced (existing behavior)
    const statusPlaceholders = statuses.map(() => "?").join(",");
    let sql = `SELECT b.customer_name, b.phone, b.service, b.branch, b.date, b.time, b.status,
                      b.staff_name, s.price AS service_price
               FROM ${tenantId}_bookings b
               LEFT JOIN ${tenantId}_services s ON b.service = s.name
               WHERE b.status IN (${statusPlaceholders})`;
    const args = [...statuses];

    if (branch && branch !== "all") { sql += " AND b.branch = ?"; args.push(branch); }
    if (rangeFrom) { sql += " AND b.date >= ?"; args.push(rangeFrom); }
    if (rangeTo) { sql += " AND b.date <= ?"; args.push(rangeTo); }

    sql += " ORDER BY b.date DESC, b.time DESC";

    const bookings = db.prepare(sql).all(...args);

    for (const b of bookings) {
      const key = b.phone || `__name_${b.customer_name}`;

      if (!clientMap.has(key)) {
        clientMap.set(key, {
          customer_name: b.customer_name,
          phone: b.phone || null,
          services: [],
          bookings: [],
          totalBookings: 0,
          totalSpent: 0,
          lastVisit: b.date,
          firstVisit: b.date,
          branches: new Set(),
        });
      }

      const client = clientMap.get(key);
      const price = parseFloat(String(b.service_price || "0").replace(/[^0-9.]/g, "")) || 0;

      const existingSvc = client.services.find(s => s.name === b.service);
      if (existingSvc) {
        existingSvc.count++;
        existingSvc.revenue += price;
      } else {
        client.services.push({
          name: b.service,
          count: 1,
          revenue: price,
        });
      }

      client.bookings.push({
        date: b.date,
        time: b.time,
        service: b.service,
        branch: b.branch,
        staff_name: b.staff_name,
        price: price,
      });

      client.totalBookings++;
      client.totalSpent += price;
      if (b.date > client.lastVisit) client.lastVisit = b.date;
      if (b.date < client.firstVisit) client.firstVisit = b.date;
      if (b.branch) client.branches.add(b.branch);
    }
  }

  // Convert to array, sort by totalSpent desc, then by totalBookings
  const clients = [...clientMap.values()]
    .map(c => ({
      ...c,
      branches: [...c.branches],
    }))
    .sort((a, b) => b.totalSpent - a.totalSpent || b.totalBookings - a.totalBookings);

  // Calculate summary stats
  const totalRevenue = clients.reduce((sum, c) => sum + c.totalSpent, 0);
  const avgSpendPerClient = clients.length > 0 ? totalRevenue / clients.length : 0;
  const newClients = clients.filter(c => c.firstVisit === c.lastVisit).length;
  const returningClients = clients.length - newClients;

  res.json({
    clients,
    totalClients: clients.length,
    totalRevenue,
    avgSpendPerClient: Math.round(avgSpendPerClient),
    newClients,
    returningClients,
    queryRange: { start: rangeFrom, end: rangeTo, tz },
    filtersApplied: { statuses, branch: branch || null, period: period || null, source },
    dataFreshAsOf: serverTime,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Salon Admin — Clients & Customer Analytics
// ─────────────────────────────────────────────────────────────────────────────

app.get("/salon-admin/api/clients", requireTenantAuth, (req, res) => {
  const tenantId = req.tenantId;
  const cache = getCache(tenantId);

  if (cache?.bookings) {
    const map = new Map();
    cache.bookings.forEach((b) => {
      if (!map.has(b.phone))
        map.set(b.phone, { customer_name: b.customer_name, phone: b.phone, booking_count: 0, last_visit: b.date });
      const c = map.get(b.phone);
      c.booking_count++;
      if (b.date > c.last_visit) c.last_visit = b.date;
    });
    return res.json([...map.values()].sort((a, b) => b.last_visit.localeCompare(a.last_visit)));
  }

  const clients = getDb().prepare(`
    SELECT customer_name, phone, COUNT(*) AS booking_count, MAX(date) AS last_visit
    FROM ${tenantId}_bookings
    GROUP BY customer_name, phone
    ORDER BY last_visit DESC
  `).all();
  res.json(clients);
});

app.get("/salon-admin/api/customer-analytics", requireTenantAuth, (req, res) => {
  const tenantId = req.tenantId;
  const db = getDb();

  const analytics = {
    topCustomers: db.prepare(`
      SELECT name, phone, total_bookings, completed, no_shows, cancellations, total_spent
      FROM ${tenantId}_customer_metrics ORDER BY total_spent DESC LIMIT 20
    `).all(),
    repeatRate: db.prepare(`
      SELECT COUNT(DISTINCT phone) AS total_customers,
             SUM(CASE WHEN total_bookings > 1 THEN 1 ELSE 0 END) AS repeat_customers
      FROM ${tenantId}_customer_metrics
    `).get(),
    noShowRate: db.prepare(`
      SELECT SUM(no_shows) * 1.0 / NULLIF(SUM(total_bookings), 0) AS rate
      FROM ${tenantId}_customer_metrics
    `).get(),
    atRiskCustomers: db.prepare(`
      SELECT name, phone, no_shows, cancellations, total_bookings
      FROM ${tenantId}_customer_metrics
      WHERE no_shows > 2 OR (no_shows * 1.0 / NULLIF(total_bookings, 0)) > 0.3
      ORDER BY no_shows DESC LIMIT 10
    `).all(),
  };
  res.json(analytics);
});

// ─────────────────────────────────────────────────────────────────────────────
//  Salon Admin — Settings: Branches
// ─────────────────────────────────────────────────────────────────────────────

app.get("/salon-admin/api/settings/branches", requireTenantAuth, (req, res) => {
  const tenantId = req.tenantId;
  const cache = getCache(tenantId);
  if (cache?.branches) return res.json(cache.branches);

  const branches = getDb().prepare(`SELECT * FROM ${tenantId}_branches ORDER BY number ASC`).all();
  res.json(branches);
});

app.post("/salon-admin/api/settings/branches", requireTenantAuth, (req, res) => {
  const tenantId = req.tenantId;
  const { name, address, map_link, phone } = req.body;
  const errs = [];
  if (!name?.trim()) errs.push("name");
  if (!address?.trim()) errs.push("address");
  if (!map_link?.trim() || !map_link.trim().startsWith("http")) errs.push("map_link (must start with http)");
  if (!phone?.trim()) errs.push("phone");
  else if (!isValidPhone(phone)) errs.push("phone (must be 8-15 digits)");
  if (errs.length)
    return res.status(400).json({ error: `Missing/invalid: ${errs.join(", ")}` });

  const db = getDb();
  const maxNum = db.prepare(`SELECT COALESCE(MAX(number), 0) AS m FROM ${tenantId}_branches`).get().m;
  const r = db.prepare(`
    INSERT INTO ${tenantId}_branches (number, name, address, map_link, phone)
    VALUES (?, ?, ?, ?, ?)
  `).run(maxNum + 1, name.trim(), address.trim(), map_link.trim(), (normalizePhone(phone) || phone.trim()));
  const newBranch = db.prepare(`SELECT * FROM ${tenantId}_branches WHERE id = ?`).get(r.lastInsertRowid);
  patchCache(tenantId, "branches", "upsert", newBranch).catch((e) =>
    logger.error("[cache] branches insert:", e.message)
  );
  res.json(newBranch);
});

app.put("/salon-admin/api/settings/branches/:id", requireTenantAuth, (req, res) => {
  const tenantId = req.tenantId;
  const { name, address, map_link, phone } = req.body;
  const errs = [];
  if (!name?.trim()) errs.push("name");
  if (!address?.trim()) errs.push("address");
  if (!map_link?.trim() || !map_link.trim().startsWith("http")) errs.push("map_link");
  if (!phone?.trim()) errs.push("phone");
  else if (!isValidPhone(phone)) errs.push("phone (must be 8-15 digits)");
  if (errs.length)
    return res.status(400).json({ error: `Missing/invalid: ${errs.join(", ")}` });

  const db = getDb();
  db.prepare(`
    UPDATE ${tenantId}_branches SET name=?, address=?, map_link=?, phone=?, updated_at=datetime('now')
    WHERE id=?
  `).run(name.trim(), address.trim(), map_link.trim(), (normalizePhone(phone) || phone.trim()), req.params.id);
  const updated = db.prepare(`SELECT * FROM ${tenantId}_branches WHERE id = ?`).get(req.params.id);
  if (updated)
    patchCache(tenantId, "branches", "upsert", updated).catch((e) =>
      logger.error("[cache] branches update:", e.message)
    );
  res.json({ ok: true });
});

app.delete("/salon-admin/api/settings/branches/:id", requireTenantAuth, (req, res) => {
  const tenantId = req.tenantId;
  getDb().prepare(`DELETE FROM ${tenantId}_branches WHERE id=?`).run(req.params.id);
  patchCache(tenantId, "branches", "delete", { id: req.params.id }).catch((e) =>
    logger.error("[cache] branches delete:", e.message)
  );
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Salon Admin — Settings: Staff
// ─────────────────────────────────────────────────────────────────────────────

app.get("/salon-admin/api/settings/staff", requireTenantAuth, (req, res) => {
  const tenantId = req.tenantId;
  const cache = getCache(tenantId);
  if (cache?.staff) return res.json(cache.staff);

  const staff = getDb().prepare(`
    SELECT s.*, b.name AS branch_name
    FROM ${tenantId}_staff s
    LEFT JOIN ${tenantId}_branches b ON s.branch_id = b.id
    ORDER BY s.name ASC
  `).all();
  res.json(staff);
});

app.post("/salon-admin/api/settings/staff", requireTenantAuth, (req, res) => {
  const tenantId = req.tenantId;
  const { name, phone, role, branch_id, status } = req.body;
  const db = getDb();
  const validRoles = db.prepare(`SELECT name FROM ${tenantId}_staff_roles`).all().map((r) => r.name);
  const errs = [];
  if (!name?.trim()) errs.push("name");
  if (!phone?.trim()) errs.push("phone");
  else if (!isValidPhone(phone)) errs.push("phone (must be 8-15 digits)");
  if (!role || !validRoles.includes(role)) errs.push(`role (${validRoles.join(", ")})`);
  if (errs.length)
    return res.status(400).json({ error: `Missing/invalid: ${errs.join(", ")}` });

  const r = db.prepare(`
    INSERT INTO ${tenantId}_staff (name, phone, role, branch_id, status)
    VALUES (?, ?, ?, ?, ?)
  `).run(name.trim(), (normalizePhone(phone) || phone.trim()), role, branch_id || null, status || "active");
  const newStaff = db.prepare(`
    SELECT s.*, b.name AS branch_name FROM ${tenantId}_staff s
    LEFT JOIN ${tenantId}_branches b ON s.branch_id = b.id WHERE s.id = ?
  `).get(r.lastInsertRowid);
  patchCache(tenantId, "staff", "upsert", newStaff).catch((e) =>
    logger.error("[cache] staff insert:", e.message)
  );
  res.json(newStaff);
});

app.put("/salon-admin/api/settings/staff/:id", requireTenantAuth, (req, res) => {
  const tenantId = req.tenantId;
  const { name, phone, role, branch_id, status } = req.body;
  const db = getDb();
  const validRoles = db.prepare(`SELECT name FROM ${tenantId}_staff_roles`).all().map((r) => r.name);
  const errs = [];
  if (!name?.trim()) errs.push("name");
  if (!phone?.trim()) errs.push("phone");
  else if (!isValidPhone(phone)) errs.push("phone (must be 8-15 digits)");
  if (!role || !validRoles.includes(role)) errs.push("role");
  if (errs.length)
    return res.status(400).json({ error: `Missing/invalid: ${errs.join(", ")}` });

  db.prepare(`
    UPDATE ${tenantId}_staff SET name=?, phone=?, role=?, branch_id=?, status=?, updated_at=datetime('now')
    WHERE id=?
  `).run(name.trim(), (normalizePhone(phone) || phone.trim()), role, branch_id || null, status || "active", req.params.id);
  const updated = db.prepare(`
    SELECT s.*, b.name AS branch_name FROM ${tenantId}_staff s
    LEFT JOIN ${tenantId}_branches b ON s.branch_id = b.id WHERE s.id = ?
  `).get(req.params.id);
  if (updated)
    patchCache(tenantId, "staff", "upsert", updated).catch((e) =>
      logger.error("[cache] staff update:", e.message)
    );
  res.json({ ok: true });
});

app.delete("/salon-admin/api/settings/staff/:id", requireTenantAuth, (req, res) => {
  const tenantId = req.tenantId;
  getDb().prepare(`DELETE FROM ${tenantId}_staff WHERE id=?`).run(req.params.id);
  patchCache(tenantId, "staff", "delete", { id: req.params.id }).catch((e) =>
    logger.error("[cache] staff delete:", e.message)
  );
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Salon Admin — Settings: Timings
// ─────────────────────────────────────────────────────────────────────────────

app.get("/salon-admin/api/settings/timings", requireTenantAuth, (req, res) => {
  const tenantId = req.tenantId;
  const cache = getCache(tenantId);
  if (cache?.salonTimings) return res.json(cache.salonTimings);

  const rows = getDb().prepare(`SELECT * FROM ${tenantId}_salon_timings`).all();
  const result = {};
  rows.forEach((r) => { result[r.day_type] = r; });
  res.json(result);
});

app.put("/salon-admin/api/settings/timings", requireTenantAuth, (req, res) => {
  const tenantId = req.tenantId;
  const { workday, weekend } = req.body;
  const timeRx = /^\d{2}:\d{2}$/;
  const errs = [];
  if (!workday?.open_time || !timeRx.test(workday.open_time)) errs.push("workday.open_time");
  if (!workday?.close_time || !timeRx.test(workday.close_time)) errs.push("workday.close_time");
  if (!weekend?.open_time || !timeRx.test(weekend.open_time)) errs.push("weekend.open_time");
  if (!weekend?.close_time || !timeRx.test(weekend.close_time)) errs.push("weekend.close_time");
  if (errs.length)
    return res.status(400).json({ error: `Invalid/missing: ${errs.join(", ")}` });
  if (workday.close_time <= workday.open_time)
    return res.status(400).json({ error: "Workday closing must be after opening" });
  if (weekend.close_time <= weekend.open_time)
    return res.status(400).json({ error: "Weekend closing must be after opening" });

  const db = getDb();
  const upsert = db.prepare(`
    INSERT INTO ${tenantId}_salon_timings (day_type, open_time, close_time, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(day_type) DO UPDATE SET
      open_time  = excluded.open_time,
      close_time = excluded.close_time,
      updated_at = excluded.updated_at
  `);
  db.transaction(() => {
    upsert.run("workday", workday.open_time, workday.close_time);
    upsert.run("weekend", weekend.open_time, weekend.close_time);
  })();

  const timings = db.prepare(`SELECT * FROM ${tenantId}_salon_timings`).all();
  const timingsMap = {};
  timings.forEach((t) => { timingsMap[t.day_type] = t; });
  patchCache(tenantId, "salonTimings", "replace", timingsMap).catch((e) =>
    logger.error("[cache] timings update:", e.message)
  );
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Salon Admin — Settings: Staff Roles
// ─────────────────────────────────────────────────────────────────────────────

app.get("/salon-admin/api/settings/roles", requireTenantAuth, (req, res) => {
  const tenantId = req.tenantId;
  const cache = getCache(tenantId);
  if (cache?.staffRoles) return res.json(cache.staffRoles);

  const roles = getDb().prepare(`SELECT * FROM ${tenantId}_staff_roles ORDER BY name ASC`).all();
  res.json(roles);
});

app.post("/salon-admin/api/settings/roles", requireTenantAuth, (req, res) => {
  const tenantId = req.tenantId;
  const { name } = req.body;
  if (!name?.trim())
    return res.status(400).json({ error: "Role name is required" });
  const normalized = name.trim().toLowerCase();
  try {
    const db = getDb();
    const r = db.prepare(`INSERT INTO ${tenantId}_staff_roles (name) VALUES (?)`).run(normalized);
    const newRole = db.prepare(`SELECT * FROM ${tenantId}_staff_roles WHERE id = ?`).get(r.lastInsertRowid);
    patchCache(tenantId, "staffRoles", "upsert", newRole).catch((e) =>
      logger.error("[cache] roles insert:", e.message)
    );
    res.json(newRole);
  } catch (err) {
    if (err.message.includes("UNIQUE"))
      return res.status(400).json({ error: "Role already exists" });
    res.status(500).json({ error: err.message });
  }
});

app.delete("/salon-admin/api/settings/roles/:id", requireTenantAuth, (req, res) => {
  const tenantId = req.tenantId;
  getDb().prepare(`DELETE FROM ${tenantId}_staff_roles WHERE id = ?`).run(req.params.id);
  patchCache(tenantId, "staffRoles", "delete", { id: req.params.id }).catch((e) =>
    logger.error("[cache] roles delete:", e.message)
  );
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Salon Admin — Settings: General (currency etc.)
// ─────────────────────────────────────────────────────────────────────────────

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
  res.json({
    ...base,
    tenantId,
    owner_name: tenant?.owner_name ?? null,
    salon_name: tenant?.salon_name ?? null,   // for Sidebar branding — LHB-01
    logo_data_uri: base.logo_data_uri ?? null, // explicit null if unset — LHB-01
  });
});

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

// Update salon name
app.put("/salon-admin/api/salon-name", requireTenantAuth, (req, res) => {
  const { salon_name } = req.body;
  if (!salon_name?.trim())
    return res.status(400).json({ error: "salon_name is required" });
  updateSalonName(req.tenantId, salon_name.trim());
  res.json({ success: true, salon_name: salon_name.trim() });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Salon Admin — Settings: Branding (logo + salon name) — LHB-01
// ─────────────────────────────────────────────────────────────────────────────
app.put("/salon-admin/api/settings/branding", requireTenantAuth, (req, res) => {
  try {
    const tenantId = req.tenantId;
    const { logo_data_uri, salon_name } = req.body || {};

    // Validate salon_name (required, 1..100 chars)
    if (typeof salon_name !== 'string' || !salon_name.trim()) {
      return res.status(400).json({ error: "salon_name is required" });
    }
    const trimmedName = salon_name.trim();
    if (trimmedName.length > 100) {
      return res.status(400).json({ error: "salon_name must be 100 characters or fewer" });
    }

    // Validate logo_data_uri (optional — null/undefined/"" clears it; otherwise must be a data URI image)
    let logoValue = null;
    if (logo_data_uri !== undefined && logo_data_uri !== null && logo_data_uri !== '') {
      if (typeof logo_data_uri !== 'string' ||
          !/^data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,/.test(logo_data_uri)) {
        return res.status(400).json({ error: "logo_data_uri must be a base64 image data URI (png/jpg/gif/webp/svg)" });
      }
      // Soft cap at ~1.5MB encoded (≈1MB raw). Body limit is 2MB so this leaves room for salon_name.
      if (logo_data_uri.length > 1_500_000) {
        return res.status(413).json({ error: "Logo is too large. Please upload an image under 1 MB." });
      }
      logoValue = logo_data_uri;
    }

    const db = getDb();
    const upsert = db.prepare(`
      INSERT INTO ${tenantId}_app_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `);
    const del = db.prepare(`DELETE FROM ${tenantId}_app_settings WHERE key = ?`);

    db.transaction(() => {
      if (logoValue === null) {
        // Empty string or explicit null → remove the key so GET returns null
        del.run('logo_data_uri');
      } else {
        upsert.run('logo_data_uri', logoValue);
      }
    })();

    // Update salon name in super.db (reuses existing helper)
    updateSalonName(tenantId, trimmedName);

    invalidateSettingsCache();
    patchCache(tenantId, "appSettings", "upsert", {
      logo_data_uri: logoValue,
    }).catch((e) => logger.error("[cache] branding patch:", e.message));

    res.json({ ok: true, salon_name: trimmedName, logo_data_uri: logoValue });
  } catch (err) {
    logger.error('[branding] update failed:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  Availability API (public — used by widget)
// ─────────────────────────────────────────────────────────────────────────────

app.get("/api/availability/check", (req, res) => {
  const { branch, date, time, service, tenantId } = req.query;
  if (!tenantId) return res.status(400).json({ error: "tenantId required" });
  if (!branch || !date || !time || !service)
    return res.status(400).json({ error: "branch, date, time, service required" });

  const db = getDb();
  const duration = getServiceDuration(service, db, tenantId);
  const endTime = calculateEndTime(time, duration);
  const staff = findAvailableStaff(date, time, endTime, branch, db, tenantId);
  const timingErr = checkBookingTimingWithEndTime(date, time, endTime, db, tenantId);

  res.json({
    available: staff.length > 0 && !timingErr,
    availableStaff: staff.map((s) => ({ id: s.id, name: s.name, role: s.role })),
    timingError: timingErr,
    suggestedTimes: timingErr ? findNextAvailableSlots(date, branch, duration, db, tenantId) : [],
  });
});

app.get("/api/availability/slots", (req, res) => {
  const { branch, date, service, tenantId } = req.query;
  if (!branch || !date || !service || !tenantId)
    return res.status(400).json({ error: "branch, date, service, tenantId required" });

  const db = getDb();
  const duration = getServiceDuration(service, db, tenantId);
  const slots = findNextAvailableSlots(date, branch, duration, db, tenantId);
  res.json({ slots });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Customer self-service API (no admin auth — uses tenantId from query/body)
// ─────────────────────────────────────────────────────────────────────────────

app.get("/api/customer/bookings", (req, res) => {
  const { phone, tenantId } = req.query;
  if (!phone) return res.status(400).json({ error: "phone required" });
  if (!tenantId) return res.status(400).json({ error: "tenantId required" });

  const db = getDb();
  const bookings = db.prepare(`
    SELECT * FROM ${tenantId}_bookings WHERE phone = ? ORDER BY date DESC, time DESC
  `).all(phone);
  const metrics = db.prepare(`SELECT * FROM ${tenantId}_customer_metrics WHERE phone = ?`).get(phone);
  res.json({ bookings, metrics });
});

app.post("/api/customer/cancel", async (req, res) => {
  const { bookingId, phone, reason, tenantId } = req.body;
  if (!tenantId) return res.status(400).json({ error: "tenantId required" });
  if (!bookingId || !phone) return res.status(400).json({ error: "bookingId and phone required" });
  if (!isValidPhone(phone)) return res.status(400).json({ error: "invalid phone" });
  const phoneNorm = normalizePhone(phone);

  const db = getDb();
  const booking = db.prepare(`SELECT * FROM ${tenantId}_bookings WHERE id = ? AND phone = ?`).get(bookingId, phoneNorm);
  if (!booking) return res.status(404).json({ error: "Booking not found" });

  const settings = db.prepare(`
    SELECT value FROM ${tenantId}_business_settings WHERE key = 'cancellation_hours'
  `).get();
  const cancellationHours = settings ? parseInt(settings.value) : 24;
  const hoursUntil = (new Date(`${booking.date}T${booking.time}`) - new Date()) / 3_600_000;

  if (hoursUntil < cancellationHours)
    return res.status(400).json({
      error: `Cannot cancel within ${cancellationHours}h of appointment. Contact salon directly.`,
    });

  db.prepare(`
    UPDATE ${tenantId}_bookings SET status='canceled', cancellation_reason=?, updated_at=datetime('now')
    WHERE id=?
  `).run(reason || "Customer canceled", bookingId);
  db.prepare(`
    UPDATE ${tenantId}_staff_bookings SET status='canceled', updated_at=datetime('now') WHERE bookingId=?
  `).run(bookingId);
  db.prepare(`
    INSERT INTO ${tenantId}_customer_metrics (phone, total_bookings, cancellations) VALUES (?, 1, 1)
    ON CONFLICT(phone) DO UPDATE SET cancellations = cancellations + 1, updated_at = datetime('now')
  `).run(phoneNorm);
  db.prepare(`
    INSERT INTO ${tenantId}_booking_audit (booking_id, old_status, new_status, changed_by, reason)
    VALUES (?, ?, 'canceled', 'customer', ?)
  `).run(bookingId, booking.status, reason);

  const updated = db.prepare(`SELECT * FROM ${tenantId}_bookings WHERE id = ?`).get(bookingId);
  await patchCache(tenantId, "bookings", "upsert", updated).catch((e) =>
    logger.error("[cache] cancel:", e.message)
  );
  res.json({ ok: true, message: "Booking cancelled", refundEligible: hoursUntil > 48 });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Salon Admin — Booking Analytics (single source of truth)
//  GET /salon-admin/api/analytics?branch=&period=week&from=&to=&status=completed&tz=Asia/Karachi
//  status may be comma-separated: "confirmed,completed"
//  period shorthand: day|week|month|year (computed in salon timezone)
// ─────────────────────────────────────────────────────────────────────────────

app.get("/salon-admin/api/analytics", requireTenantAuth, (req, res) => {
  const tenantId = req.tenantId;
  const db = getDb();
  // ✅ FIX: Default to "completed" so revenue calcs are semantically correct
  const { branch, from, to, status = "completed", period, tz = "UTC" } = req.query;

  // ✅ FIX: Accept comma-separated status values (e.g., "confirmed,completed")
  const statuses = status.split(",").map((s) => s.trim()).filter(Boolean);

  // ✅ FIX: Compute date range from period using salon timezone
  let rangeFrom = from || null;
  let rangeTo = to || null;
  const serverTime = new Date().toISOString();

  if (period && !from && !to) {
    try {
      const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: tz }); // YYYY-MM-DD

      if (period === "day") {
        rangeFrom = todayStr;
        rangeTo = todayStr;
      } else if (period === "week") {
        const d = new Date(todayStr);
        d.setDate(d.getDate() - d.getDay()); // Start of week (Sunday)
        rangeFrom = d.toISOString().slice(0, 10);
        rangeTo = todayStr;
      } else if (period === "month") {
        rangeFrom = todayStr.slice(0, 7) + "-01"; // First of month
        rangeTo = todayStr;
      } else if (period === "year") {
        rangeFrom = todayStr.slice(0, 4) + "-01-01";
        rangeTo = todayStr;
      }
    } catch {
      // period ignored if tz is invalid
    }
  }

  // Build WHERE clause
  const statusPlaceholders = statuses.map(() => "?").join(",");
  let sql = `SELECT b.*, s.price AS service_price, i.total AS invoice_total, i.tips AS invoice_tips
             FROM ${tenantId}_bookings b
             LEFT JOIN ${tenantId}_services s ON b.service = s.name
             LEFT JOIN ${tenantId}_invoices i ON i.booking_id = b.id
             WHERE b.status IN (${statusPlaceholders})`;
  const args = [...statuses];

  if (branch && branch !== "all") { sql += " AND b.branch = ?"; args.push(branch); }
  if (rangeFrom) { sql += " AND b.date >= ?"; args.push(rangeFrom); }
  if (rangeTo)   { sql += " AND b.date <= ?"; args.push(rangeTo); }

  const bookings = db.prepare(sql).all(...args);

  // Prefer invoice_total - tips when present (tips belong to staff, not the salon);
  // fallback to service_price for pre-invoice completed bookings.
  const priceOf = (b) => {
    if (b.invoice_total != null) {
      const tips = Number(b.invoice_tips) || 0;
      return (Number(b.invoice_total) || 0) - tips;
    }
    return parseFloat(String(b.service_price || "0").replace(/[^0-9.]/g, "")) || 0;
  };

  // ── Aggregations (all derived from the same query result) ─────────────────
  const totalRevenue = bookings.reduce((sum, b) => sum + priceOf(b), 0);

  const serviceMap = {};
  const dealMap = {};
  const revenueByService = {};

  for (const b of bookings) {
    const svc = b.service || "Unknown";
    serviceMap[svc] = (serviceMap[svc] || 0) + 1;

    const price = priceOf(b);
    revenueByService[svc] = (revenueByService[svc] || 0) + price;

    if (b.deal_name) dealMap[b.deal_name] = (dealMap[b.deal_name] || 0) + 1;
  }

  const topServices = Object.entries(serviceMap)
    .sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([name, count]) => ({ name, count, revenue: revenueByService[name] || 0 }));

  const topDeals = Object.entries(dealMap)
    .sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([name, count]) => ({ name, count }));

  const revenueByServiceArr = Object.entries(revenueByService)
    .sort((a, b) => b[1] - a[1])
    .map(([name, revenue]) => ({
      name,
      revenue,
      percent: totalRevenue > 0 ? Math.round((revenue / totalRevenue) * 100) : 0,
    }));

  const bookingsByBranch = {};
  const revenueByBranch = {};
  for (const b of bookings) {
    const key = b.branch || "Unknown";
    bookingsByBranch[key] = (bookingsByBranch[key] || 0) + 1;
    revenueByBranch[key] = (revenueByBranch[key] || 0) + priceOf(b);
  }

  // Status breakdown — always all statuses, same date/branch filter (ignores status param)
  let statusSql = `SELECT b.status, COUNT(*) as count FROM ${tenantId}_bookings b WHERE 1=1`;
  const statusArgs = [];
  if (branch && branch !== "all") { statusSql += " AND b.branch = ?"; statusArgs.push(branch); }
  if (rangeFrom) { statusSql += " AND b.date >= ?"; statusArgs.push(rangeFrom); }
  if (rangeTo)   { statusSql += " AND b.date <= ?"; statusArgs.push(rangeTo); }
  statusSql += " GROUP BY b.status";
  const statusRows = db.prepare(statusSql).all(...statusArgs);
  const bookingsByStatus = {};
  for (const row of statusRows) {
    if (row.status) bookingsByStatus[row.status] = row.count;
  }

  res.json({
    totalRevenue,
    bookingCount: bookings.length,
    topServices,
    topDeals,
    revenueByService: revenueByServiceArr,
    bookingsByBranch,
    revenueByBranch,
    bookingsByStatus,
    // ✅ Metadata: client can verify filter applied
    queryRange: { start: rangeFrom, end: rangeTo, tz },
    filtersApplied: { statuses, branch: branch || null, period: period || null },
    dataFreshAsOf: serverTime,
    serverTime,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Salon Admin — Tenant Status (for frontend suspension modal polling)
//  Does NOT use requireTenantAuth — it reports the suspended state itself,
//  so it must remain reachable when the tenant is suspended.
// ─────────────────────────────────────────────────────────────────────────────
app.get("/salon-admin/api/tenant-status", (req, res) => {
  try {
    const token = req.cookies.tenantToken;
    if (!token) return res.status(401).json({ error: "Unauthorized" });

    const JWT_SECRET = process.env.TENANT_JWT_SECRET || "your-super-secret-jwt-key-change-this";
    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch (_) {
      return res.status(401).json({ error: "Invalid or expired session" });
    }

    const tenant = getTenantById(decoded.tenantId);
    if (!tenant) return res.status(404).json({ error: "Tenant not found" });

    const access = getTenantAccessStatus(decoded.tenantId);
    res.json({
      tenant_id: tenant.tenant_id,
      status: access.active ? 'active' : 'suspended',
      reason: access.reason,
      salon_name: tenant.salon_name
    });
  } catch (err) {
    logger.error("[tenant-status] Error:", err.message);
    res.status(500).json({ error: "Something went wrong" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  Salon Admin — Plan Features (feature flags for UI conditional rendering)
//  Reads live from super.db on every call — NOT cached in JWT (SEC-03).
// ─────────────────────────────────────────────────────────────────────────────
app.get("/salon-admin/api/plan-features", requireTenantAuth, (req, res) => {
  try {
    const superDb = getSuperDb();
    const row = superDb.prepare(`
      SELECT p.max_services, p.whatsapp_access, p.instagram_access,
             p.facebook_access, p.widget_access, p.ai_calls_access
      FROM subscriptions s
      JOIN plans p ON p.id = s.plan_id
      WHERE s.tenant_id = ? AND s.status = 'active'
      ORDER BY s.created_at DESC LIMIT 1
    `).get(req.tenantId);

    if (!row) {
      // No active subscription → restrictive defaults (matches planGate behavior)
      return res.json({
        max_services: 10,
        whatsapp_access: 0,
        instagram_access: 0,
        facebook_access: 0,
        widget_access: 0,
        ai_calls_access: 0,
      });
    }
    res.json(row);
  } catch (err) {
    logger.error("[admin] plan-features error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  Salon Admin — CORS Origin (per-tenant widget/voice CORS setting)
// ─────────────────────────────────────────────────────────────────────────────

app.get("/salon-admin/api/cors-origin", requireTenantAuth, (req, res) => {
  try {
    const result = getTenantCorsOrigin(req.tenantId);
    res.json({ ok: true, cors_origin: result });
  } catch (err) {
    logger.error("[cors-origin] GET failed", err);
    res.json({ ok: false, error: err.message });
  }
});

app.put("/salon-admin/api/cors-origin", requireTenantAuth, (req, res) => {
  try {
    const { cors_origin } = req.body;
    setTenantCorsOrigin(req.tenantId, cors_origin || null);
    res.json({ ok: true });
  } catch (err) {
    logger.error("[cors-origin] PUT failed", err);
    res.json({ ok: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  Salon Admin — Current Subscription Details
// ─────────────────────────────────────────────────────────────────────────────
app.get("/salon-admin/api/subscription/current", requireTenantAuth, (req, res) => {
  try {
    const sub = getTenantSubscription(req.tenantId);
    
    // Always return a valid response, never undefined
    if (!sub) {
      return res.json({
        id: null,
        planId: null,
        planName: "Free",
        priceCents: 0,
        billingCycle: "monthly",
        status: "active",
        currentPeriodEnd: null,
        remainingDays: null,
        remainingDaysText: null,
        features: {
          maxServices: 5,
          whatsappAccess: false,
          instagramAccess: false,
          facebookAccess: false,
          aiCallsAccess: false,
          widgetAccess: false,
        }
      });
    }

    // Get plan details
    const plan = getPlanById(sub.plan_id);
    
    const response = {
      id: sub.id,
      planId: sub.plan_id,
      planName: plan?.name || "Unknown",
      priceCents: plan?.price_cents || 0,
      billingCycle: plan?.billing_cycle || "monthly",
      status: sub.status || "active",
      currentPeriodEnd: sub.current_period_end || null,
      remainingDays: sub.remaining_days || null,
      remainingDaysText: sub.remaining_days_text || null,
      features: {
        maxServices: plan?.max_services || 5,
        whatsappAccess: plan?.whatsapp_access === 1,
        instagramAccess: plan?.instagram_access === 1,
        facebookAccess: plan?.facebook_access === 1,
        aiCallsAccess: plan?.ai_calls_access === 1,
        widgetAccess: plan?.widget_access === 1,
      }
    };
    
    res.json(response);
  } catch (err) {
    logger.error("[subscription/current] Error:", err.message);
    // Always return a valid response even on error
    res.json({
      id: null,
      planId: null,
      planName: "Free",
      priceCents: 0,
      billingCycle: "monthly",
      status: "active",
      currentPeriodEnd: null,
      remainingDays: null,
      remainingDaysText: null,
      features: {
        maxServices: 5,
        whatsappAccess: false,
        instagramAccess: false,
        facebookAccess: false,
        aiCallsAccess: false,
        widgetAccess: false,
      }
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  Salon Admin — Upgrade/Downgrade Subscription
// ─────────────────────────────────────────────────────────────────────────────

app.post("/salon-admin/api/subscription/upgrade", requireTenantAuth, async (req, res) => {
  try {
    const { plan_id } = req.body;

    if (!plan_id) {
      return res.status(400).json({ error: "plan_id is required" });
    }

    const planIdNum = parseInt(plan_id, 10);
    if (isNaN(planIdNum) || planIdNum <= 0) {
      return res.status(400).json({ error: "plan_id must be a positive integer" });
    }

    // Get current subscription
    const currentSub = getTenantSubscription(req.tenantId);
    const newPlan = getPlanById(planIdNum);

    if (!newPlan) {
      return res.status(404).json({ error: "Plan not found" });
    }

    // Check if trying to switch to same plan
    if (currentSub && currentSub.plan_id === planIdNum) {
      return res.status(400).json({ error: "Already on this plan" });
    }

    // For free plan or downgrade (to cheaper or free plan) - update immediately
    if (newPlan.price_cents === 0 ||
      (currentSub && newPlan.price_cents < currentSub.price_cents)) {

      // Update subscription
      updateSubscriptionByTenantId(req.tenantId, {
        planId: planIdNum,
        status: 'active',
        updatedAt: new Date().toISOString()
      });

      // Apply service freeze/unfreeze based on new max_services limit
      if (newPlan.max_services !== undefined) {
        freezeExcessServices(req.tenantId, newPlan.max_services);
        unfreezeServices(req.tenantId, newPlan.max_services);
      }

      // Send downgrade email notification
      const tenant = getTenantById(req.tenantId);
      if (tenant && currentSub && newPlan.price_cents < currentSub.price_cents) {
        const oldPlan = getPlanById(currentSub.plan_id);
        try {
          await sendPlanDowngradeEmail({
            to: tenant.email,
            ownerName: tenant.owner_name,
            salonName: tenant.salon_name,
            oldPlanName: oldPlan?.name || "Unknown",
            newPlanName: newPlan.name,
            effectiveDate: new Date().toLocaleDateString(),
          });
        } catch (emailErr) {
          logger.error("[email] downgrade error:", emailErr.message);
        }
      }

      // Invalidate cache for this tenant
      try {
        await patchCache(req.tenantId, "subscription", "replace", { planId: planIdNum });
      } catch (e) {
        logger.error("[cache] subscription update:", e.message);
      }

      logger.info(`[subscription] Tenant ${req.tenantId} ${currentSub?.price_cents > newPlan.price_cents ? 'downgraded' : 'changed'} to plan ${newPlan.name} (${newPlan.price_cents === 0 ? 'free' : 'paid'})`);

      return res.json({
        success: true,
        message: `Plan ${currentSub?.price_cents > newPlan.price_cents ? 'downgraded' : 'updated'} successfully`
      });
    }

    // For upgrade to paid plan - create Stripe checkout session
    if (!newPlan.stripe_price_id) {
      return res.status(400).json({
        error: "This plan is not yet available for purchase. Please contact support."
      });
    }

    // Get tenant details for checkout
    const tenant = getTenantById(req.tenantId);
    if (!tenant) {
      return res.status(404).json({ error: "Tenant not found" });
    }

    // Get Stripe customer ID from existing subscription if available
    let stripeCustomerId = null;
    if (currentSub && currentSub.stripe_customer_id) {
      stripeCustomerId = currentSub.stripe_customer_id;
    }

    // ✅ FIXED: Use createUpgradeCheckoutSession instead of createCheckoutSession
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3002';

    const session = await createUpgradeCheckoutSession({
      planId: newPlan.id,
      stripePriceId: newPlan.stripe_price_id,
      email: tenant.email,
      ownerName: tenant.owner_name,
      salonName: tenant.salon_name,
      phone: tenant.phone,
      successUrl: `${frontendUrl}/success?session_id={CHECKOUT_SESSION_ID}&upgrade=true`,
      cancelUrl: `${frontendUrl}/salon-admin/dashboard?tab=plan&upgrade_cancelled=true`,
      stripeCustomerId: stripeCustomerId,
      tenantId: req.tenantId,
      oldPlanId: currentSub?.plan_id?.toString() || 'none',  // ✅ Add this
    });

    res.json({ checkout_url: session.url });

  } catch (err) {
    logger.error("[subscription/upgrade] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  Salon Admin — Webhook Config (per-tenant platform credentials)
// ─────────────────────────────────────────────────────────────────────────────

app.get("/salon-admin/api/webhook-config", requireTenantAuth, (req, res) => {
  const config = getWebhookConfig(req.tenantId);
  // Webhook URLs are always the same regardless of whether credentials are saved
  const webhook_urls = {
    whatsapp:  `/webhooks/${req.tenantId}/whatsapp`,
    instagram: `/webhooks/${req.tenantId}/instagram`,
    facebook:  `/webhooks/${req.tenantId}/facebook`,
  };
  if (!config) {
    return res.json({
      has_whatsapp: false,
      has_instagram: false,
      has_facebook: false,
      wa_verified: false,
      ig_verified: false,
      fb_verified: false,
      wa_credentials_valid: false,
      ig_credentials_valid: false,
      fb_credentials_valid: false,
      wa_phone_number_id: "",
      webhook_urls,
    });
  }
  // Never return tokens to the frontend — return only metadata
  res.json({
    has_whatsapp: !!(config.wa_access_token),
    has_instagram: !!(config.ig_page_access_token),
    has_facebook: !!(config.fb_page_access_token),
    wa_verified: !!(config.wa_webhook_verified),
    ig_verified: !!(config.ig_webhook_verified),
    fb_verified: !!(config.fb_webhook_verified),
    wa_credentials_valid: !!(config.wa_credentials_valid),
    ig_credentials_valid: !!(config.ig_credentials_valid),
    fb_credentials_valid: !!(config.fb_credentials_valid),
    wa_phone_number_id: config.wa_phone_number_id || "",
    webhook_urls,
  });
});

app.put("/salon-admin/api/webhook-config", requireTenantAuth, async (req, res) => {
  const {
    wa_phone_number_id, wa_access_token, wa_verify_token,
    ig_page_access_token, ig_verify_token,
    fb_page_access_token, fb_verify_token,
  } = req.body;

  // FEAT-04 / SEC-02: enforce plan features per channel the body is trying to save.
  // Reads plan flags live from super.db (no JWT caching, SEC-03).
  const wantsWhatsapp  = !!(wa_phone_number_id || wa_access_token || wa_verify_token);
  const wantsInstagram = !!(ig_page_access_token || ig_verify_token);
  const wantsFacebook  = !!(fb_page_access_token || fb_verify_token);

  if (wantsWhatsapp || wantsInstagram || wantsFacebook) {
    const sub = getTenantSubscription(req.tenantId);
    const blocked = [];
    if (wantsWhatsapp  && !(sub && sub.whatsapp_access  === 1)) blocked.push('whatsapp');
    if (wantsInstagram && !(sub && sub.instagram_access === 1)) blocked.push('instagram');
    if (wantsFacebook  && !(sub && sub.facebook_access  === 1)) blocked.push('facebook');
    if (blocked.length) {
      return res.status(403).json({
        ok: false,
        error: `Feature not available on your plan: ${blocked.join(', ')}`,
      });
    }
  }

  upsertWebhookConfig(req.tenantId, {
    wa_phone_number_id, wa_access_token, wa_verify_token,
    ig_page_access_token, ig_verify_token,
    fb_page_access_token, fb_verify_token,
  });

  // Validate credentials against Meta Graph API (fail-open: never abort the save)
  const validation = {};
  try {
    // Re-read merged row so we test against what's actually stored.
    const stored = getWebhookConfig(req.tenantId) || {};
    if (wantsWhatsapp) {
      const r = await testWhatsAppCredentials({
        phone_number_id: stored.wa_phone_number_id,
        access_token: stored.wa_access_token,
      });
      setCredentialsValid(req.tenantId, 'whatsapp', r.ok);
      validation.whatsapp = r;
      logger.info(`[webhook-config] tenant=${req.tenantId} WA credentials_valid=${r.ok}`);
    }
    if (wantsInstagram) {
      const r = await testInstagramCredentials({ page_access_token: stored.ig_page_access_token });
      setCredentialsValid(req.tenantId, 'instagram', r.ok);
      validation.instagram = r;
      logger.info(`[webhook-config] tenant=${req.tenantId} IG credentials_valid=${r.ok}`);
    }
    if (wantsFacebook) {
      const r = await testFacebookCredentials({ page_access_token: stored.fb_page_access_token });
      setCredentialsValid(req.tenantId, 'facebook', r.ok);
      validation.facebook = r;
      logger.info(`[webhook-config] tenant=${req.tenantId} FB credentials_valid=${r.ok}`);
    }
  } catch (err) {
    logger.error(`[webhook-config] credential test failed for ${req.tenantId}: ${err.message}`);
    // Never abort the save — credentials stay stored, validation remains absent/false.
  }

  res.json({ ok: true, validation });
});

app.delete("/salon-admin/api/webhook-config/:channel", requireTenantAuth, (req, res) => {
  const { channel } = req.params;
  if (!["whatsapp", "instagram", "facebook"].includes(channel)) {
    return res.status(400).json({ error: "Invalid channel" });
  }
  clearWebhookChannel(req.tenantId, channel);
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Run-seed utility
// ─────────────────────────────────────────────────────────────────────────────

app.get("/run-seed", async (req, res) => {
  if (req.query.key !== (process.env.SALON_DATA_KEY || "adminkey123"))
    return res.status(401).send("Unauthorized");
  const tenantId = req.query.tenantId;
  if (!tenantId) return res.status(400).send("tenantId required");

  try {
    delete require.cache[require.resolve("./db/seed.js")];
    require("./db/seed.js")(tenantId);

    const db = getDb();
    const updatedDeals = db.prepare(`SELECT * FROM ${tenantId}_deals ORDER BY id`).all();
    const updatedServices = db.prepare(`SELECT * FROM ${tenantId}_services ORDER BY branch, name`).all();
    const updatedStaff = db.prepare(`
      SELECT s.*, b.name AS branch_name FROM ${tenantId}_staff s
      LEFT JOIN ${tenantId}_branches b ON s.branch_id = b.id ORDER BY s.name
    `).all();
    const settingRows = db.prepare(`SELECT key, value FROM ${tenantId}_app_settings`).all();
    const updatedSettings = {};
    settingRows.forEach((r) => { updatedSettings[r.key] = r.value; });

    await Promise.all([
      patchCache(tenantId, "deals", "replace", updatedDeals),
      patchCache(tenantId, "services", "replace", updatedServices),
      patchCache(tenantId, "staff", "replace", updatedStaff),
      patchCache(tenantId, "appSettings", "replace", updatedSettings),
    ]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).send(err.toString());
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  Super Admin — Auth
// ─────────────────────────────────────────────────────────────────────────────

app.get("/super-admin/login", (_req, res) => {
  const fp = path.join(__dirname, "admin/views/super-login.html");
  res.sendFile(fp, (err) => {
    if (err) res.status(500).send("super-login.html not found");
  });
});

// app.post("/super-admin/login", (req, res) => {
//   const ip = req.ip || req.socket?.remoteAddress || "unknown";
//   if (rateLimit(`login:super:${ip}`, 3, 15 * 60_000))
//     return res.status(429).send("Too many login attempts. Try again in 15 minutes.");

//   const { username, password } = req.body;
//   if (!username || !password)
//     return res.status(400).send("Username and password required");

//   const superDb = getSuperDb();
//   try {
//     const admin = superDb.prepare("SELECT * FROM super_admin WHERE username = ?").get(username);
//     if (admin && bcrypt.compareSync(password, admin.password_hash)) {
//       const token = jwt.sign(
//         { username: admin.username, role: "super_admin", email: admin.email },
//         JWT_SECRET,
//         { expiresIn: "1d" }
//       );
//       res.cookie("superAdminSession", token, { httpOnly: true, sameSite: "lax", maxAge: 86_400_000, path: "/" });
//       // Support both JSON fetch (frontend) and HTML form POST (legacy)
//       if (req.headers["content-type"]?.includes("application/json")) {
//         return res.json({ ok: true });
//       }
//       return res.redirect("/super-admin/dashboard");
//     }
//     if (req.headers["content-type"]?.includes("application/json")) {
//       return res.status(401).json({ ok: false, error: "Invalid credentials" });
//     }
//     res.status(401).send("Invalid credentials");
//   } catch (err) {
//     logger.error("[super-admin login]", err.message);
//     if (req.headers["content-type"]?.includes("application/json")) {
//       return res.status(500).json({ ok: false, error: err.message });
//     }
//     res.status(500).send("Login error: " + err.message);
//   }
// });

app.post("/super-admin/login", (req, res) => {
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  if (rateLimit(`login:super:${ip}`, 3, 15 * 60_000))
    return res.status(429).json({ error: "Too many login attempts. Try again in 15 minutes." });

  const { username, password } = req.body;

  console.log("[SUPER LOGIN] Attempt for username:", username);

  if (!username || !password) {
    return res.status(400).json({ error: "Username and password required" });
  }

  const superDb = getSuperDb();
  try {
    const admin = superDb.prepare("SELECT * FROM super_admin WHERE username = ?").get(username);

    if (!admin) {
      console.log("[SUPER LOGIN] User not found:", username);
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const passwordValid = bcrypt.compareSync(password, admin.password_hash);

    if (!passwordValid) {
      console.log("[SUPER LOGIN] Invalid password for:", username);
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const token = jwt.sign(
      { username: admin.username, role: "super_admin", email: admin.email },
      JWT_SECRET,
      { expiresIn: "1d" }
    );

    res.cookie("superAdminSession", token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 86_400_000,
      path: "/",
    });

    // Always return JSON for fetch requests
    return res.json({ ok: true, redirect: "/super-admin/dashboard" });

  } catch (err) {
    console.error("[super-admin login error]", err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.get("/super-admin/dashboard", requireSuperAdminAuth, (_req, res) => {
  const fp = path.join(__dirname, "admin/views/super-dashboard.html");
  res.sendFile(fp, (err) => {
    if (err) res.status(500).send("super-dashboard.html not found");
  });
});

app.get("/super-admin/logout", (_req, res) => {
  res.clearCookie("superAdminSession");
  res.redirect("/super-admin/login");
});

// ─────────────────────────────────────────────────────────────────────────────
//  Super Admin — API
// ─────────────────────────────────────────────────────────────────────────────

app.get("/super-admin/api/stats", requireSuperAdminAuth, (_req, res) => {
  try {
    const tenants = getAllTenants();
    const activeTenants = tenants.filter((t) => t.status === "active");
    
    // Calculate MRR from active subscriptions
    let mrr = 0;
    const now = new Date();
    const currentMonth = now.getMonth();
    const currentYear = now.getFullYear();
    
    // Get all active subscriptions
    const subscriptions = getSubscriptions();
    
    for (const sub of subscriptions) {
      // Only count active subscriptions
      if (sub.status !== 'active') continue;
      
      // Get the plan details
      const plan = getPlanById(sub.plan_id);
      if (!plan) continue;
      
      // Check if subscription is active this month
      let isActiveThisMonth = false;
      if (sub.current_period_start && sub.current_period_end) {
        const periodStart = new Date(sub.current_period_start);
        const periodEnd = new Date(sub.current_period_end);
        const nowDate = new Date();
        
        // Check if current date falls within the subscription period
        isActiveThisMonth = nowDate >= periodStart && nowDate <= periodEnd;
      } else {
        // If no period dates, assume active
        isActiveThisMonth = true;
      }
      
      if (!isActiveThisMonth) continue;
      
      // Calculate monthly recurring revenue based on billing cycle
      if (plan.billing_cycle === 'monthly') {
        mrr += plan.price_cents;
      } else if (plan.billing_cycle === 'yearly') {
        mrr += plan.price_cents / 12;
      }
      // one-time plans don't count toward MRR
    }
    
    // Calculate new tenants this month
    const newThisMonth = tenants.filter(t => {
      const createdAt = new Date(t.created_at);
      return createdAt.getMonth() === currentMonth && 
             createdAt.getFullYear() === currentYear;
    }).length;
    
    // Calculate revenue change from previous month (simplified)
    // You can enhance this by storing previous month's MRR in a separate table
    const revenueChange = 0; // You can implement this by tracking historical MRR
    
    res.json({
      total_tenants: tenants.length,
      active_tenants: activeTenants.length,
      new_this_month: newThisMonth,
      mrr: Math.round(mrr), // Return in cents
      revenue_change: revenueChange,
    });
  } catch (err) {
    logger.error("[super-admin stats] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/super-admin/api/tenants", requireSuperAdminAuth, (_req, res) => {
  try {
    res.json(getAllTenants());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/super-admin/api/tenants", requireSuperAdminAuth, async (req, res) => {
  const { owner_name, salon_name, email, phone, password, plan_id } = req.body;
  if (!owner_name || !salon_name || !email || !phone)
    return res.status(400).json({ error: "Missing required fields" });
  if (!isValidPhone(phone))
    return res.status(400).json({ error: "Invalid phone number (must be 8-15 digits, optional leading +)." });
  const normalizedSuperTenantPhone = normalizePhone(phone);
  try {
    const generatedPassword = password || Math.random().toString(36).slice(-8);
    const tenantId = await createTenant(owner_name, salon_name, email, normalizedSuperTenantPhone, generatedPassword);

    if (plan_id) {
      const planIdNum = parseInt(plan_id, 10);
      const plan = getPlanById(planIdNum);
      if (plan) {
        const now = new Date();
        const periodStart = now.toISOString();
        let periodEnd = null;
        if (plan.billing_cycle === 'monthly') {
          const end = new Date(now); end.setMonth(end.getMonth() + 1); periodEnd = end.toISOString();
        } else if (plan.billing_cycle === 'yearly') {
          const end = new Date(now); end.setFullYear(end.getFullYear() + 1); periodEnd = end.toISOString();
        }
        createSubscription(tenantId, planIdNum, null, null, periodStart, periodEnd);
      }
    }

    await initCache(tenantId).catch((e) => logger.warn("[cache] new tenant init:", e.message));
    res.json({ success: true, tenant_id: tenantId, password: generatedPassword });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch("/super-admin/api/tenants/:tenantId/status", requireSuperAdminAuth, (req, res) => {
  const { status } = req.body;
  if (!["active", "suspended"].includes(status))
    return res.status(400).json({ error: "status must be 'active' or 'suspended'" });
  try {
    updateTenantStatus(req.params.tenantId, status);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch("/super-admin/api/tenants/:tenantId/plan", requireSuperAdminAuth, (req, res) => {
    const { tenantId } = req.params;
    const { plan_id } = req.body || {};

    if (!plan_id) {
        return res.status(400).json({ ok: false, error: 'plan_id is required' });
    }
    const planIdNum = parseInt(plan_id, 10);
    if (Number.isNaN(planIdNum) || planIdNum <= 0) {
        return res.status(400).json({ ok: false, error: 'plan_id must be a positive integer' });
    }

    try {
        setTenantPlanOverride(tenantId, planIdNum);
        logger.info(`[admin plan override] tenant=${tenantId} plan=${planIdNum}`);
        res.json({ ok: true });
    } catch (err) {
        logger.error('[admin plan override]', err.message);
        res.json({ ok: false, error: err.message });
    }
});

app.post("/super-admin/api/settings", requireSuperAdminAuth, (req, res) => {
  const { default_plan } = req.body;
  if (default_plan) process.env.DEFAULT_PLAN = default_plan;
  res.json({ success: true });
});

// Super admin — set CORS origin for a specific tenant
app.patch("/super-admin/api/tenants/:tenantId/cors-origin", requireSuperAdminAuth, (req, res) => {
  try {
    const { tenantId } = req.params;
    const { cors_origin } = req.body || {};
    const tenant = getTenantById(tenantId);
    if (!tenant) return res.status(404).json({ ok: false, error: 'Tenant not found' });
    setTenantCorsOrigin(tenantId, cors_origin || null);
    logger.info(`[super-admin] cors_origin set for ${tenantId}: ${cors_origin || 'null'}`);
    res.json({ ok: true });
  } catch (err) {
    logger.error('[super-admin cors-origin]', err.message);
    res.json({ ok: false, error: err.message });
  }
});

// Super admin — get CORS origin for a specific tenant
app.get("/super-admin/api/tenants/:tenantId/cors-origin", requireSuperAdminAuth, (req, res) => {
  try {
    const { tenantId } = req.params;
    const cors_origin = getTenantCorsOrigin(tenantId);
    res.json({ ok: true, cors_origin });
  } catch (err) {
    logger.error('[super-admin cors-origin]', err.message);
    res.json({ ok: false, error: err.message });
  }
});

// List pending password-reset requests
app.get("/super-admin/api/reset-requests", requireSuperAdminAuth, (_req, res) => {
    // Deprecated — reset requests are now handled via email tokens
    res.json([]);
});

// Super admin sets a new password for a tenant
app.post("/super-admin/api/tenants/:tenantId/set-password", requireSuperAdminAuth, (req, res) => {
  const { tenantId } = req.params;
  const { newPassword } = req.body;
  if (!newPassword) return res.status(400).json({ error: "newPassword required" });
  if (newPassword.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });

  try {
    updateTenantPassword(tenantId, newPassword);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Super admin changes their own password
app.put("/super-admin/api/change-password", requireSuperAdminAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword)
    return res.status(400).json({ error: "currentPassword and newPassword required" });
  if (newPassword.length < 6)
    return res.status(400).json({ error: "New password must be at least 6 characters" });

  const superDb = getSuperDb();
  const admin = superDb.prepare("SELECT * FROM super_admin WHERE username = ?").get(req.superAdmin.username);
  if (!admin) return res.status(404).json({ error: "Admin not found" });

  if (!bcrypt.compareSync(currentPassword, admin.password_hash))
    return res.status(401).json({ error: "Current password is incorrect" });

  changeSuperAdminPassword(req.superAdmin.username, newPassword);
  res.json({ ok: true });
});

// ── Super Admin — Plan Management ─────────────────────────────────────────────

app.get("/super-admin/api/plans", requireSuperAdminAuth, (_req, res) => {
    try {
        res.json(getAllPlans());
    } catch (err) {
        logger.error('[plans list]', err.message);
        res.status(500).json({ error: 'Failed to fetch plans' });
    }
});

app.post("/super-admin/api/plans", requireSuperAdminAuth, (req, res) => {
    const { name, description, price_cents, billing_cycle, max_services,
            whatsapp_access, instagram_access, facebook_access, ai_calls_access,
            stripe_price_id } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    if (price_cents === undefined || price_cents === null)
        return res.status(400).json({ error: 'price_cents is required' });
    const parsedPrice = parseInt(price_cents, 10);
    if (isNaN(parsedPrice) || parsedPrice < 0)
        return res.status(400).json({ error: 'price_cents must be a non-negative integer' });
    const parsedMaxServices = parseInt(max_services || 10, 10);
    try {
        const plan = createPlan({
            name, description, price_cents: parsedPrice,
            billing_cycle: billing_cycle || 'monthly',
            max_services: (isNaN(parsedMaxServices) || parsedMaxServices < 1) ? 10 : parsedMaxServices,
            whatsapp_access: !!whatsapp_access,
            instagram_access: !!instagram_access,
            facebook_access: !!facebook_access,
            ai_calls_access: !!ai_calls_access,
            stripe_price_id: stripe_price_id || null,
        });
        res.status(201).json(plan);
    } catch (err) {
        logger.error('[plan create]', err.message);
        res.status(500).json({ error: 'Failed to create plan' });
    }
});

app.put("/super-admin/api/plans/:planId", requireSuperAdminAuth, (req, res) => {
    const planId = parseInt(req.params.planId, 10);
    if (isNaN(planId)) return res.status(400).json({ error: 'planId must be a number' });
    const plan = getPlanById(planId);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    try {
        const { name, description, price_cents: pc, billing_cycle, max_services: ms,
                whatsapp_access, instagram_access, facebook_access, ai_calls_access,
                stripe_price_id, is_active } = req.body;
        const updated = updatePlan(planId, {
            name, description, price_cents: pc, billing_cycle, max_services: ms,
            whatsapp_access, instagram_access, facebook_access, ai_calls_access,
            stripe_price_id, is_active,
        });
        // OOC-FIX-01: if max_services was in the request body, re-apply freeze/unfreeze
        // to all tenants currently subscribed to this plan.
        if (ms !== undefined && ms !== null) {
            const parsedMs = parseInt(ms, 10);
            if (Number.isFinite(parsedMs) && parsedMs >= 0) {
                try {
                    const subs = getSubscriptions().filter(
                        (s) => s.plan_id === planId && s.status === 'active'
                    );
                    for (const sub of subs) {
                        freezeExcessServices(sub.tenant_id, parsedMs);
                        unfreezeServices(sub.tenant_id, parsedMs);
                    }
                    if (subs.length) {
                        logger.info(`[plan update] re-applied freeze/unfreeze for ${subs.length} subscriber(s) of plan ${planId} (max_services=${parsedMs})`);
                    }
                } catch (hookErr) {
                    // Don't fail the plan update if freeze hooks error — log and continue
                    logger.error('[plan update] freeze hook failed:', hookErr.message);
                }
            }
        }
        res.json(updated);
    } catch (err) {
        logger.error('[plan update]', err.message);
        res.status(500).json({ error: 'Failed to update plan' });
    }
});

app.delete("/super-admin/api/plans/:planId", requireSuperAdminAuth, (req, res) => {
    const planId = parseInt(req.params.planId, 10);
    if (isNaN(planId)) return res.status(400).json({ error: 'planId must be a number' });
    const plan = getPlanById(planId);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    try {
        deletePlan(planId);
        res.json({ ok: true });
    } catch (err) {
        logger.error('[plan delete]', err.message);
        res.status(500).json({ error: 'Failed to delete plan' });
    }
});

app.delete("/super-admin/api/plans/:planId/permanent", requireSuperAdminAuth, (req, res) => {
    const planId = parseInt(req.params.planId, 10);
    if (isNaN(planId)) return res.status(400).json({ error: 'planId must be a number' });
    const plan = getPlanById(planId);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    try {
        hardDeletePlan(planId);
        res.json({ ok: true });
    } catch (err) {
        logger.error('[plan hard delete]', err.message);
        res.status(500).json({ error: 'Failed to delete plan permanently' });
    }
});

app.get("/super-admin/api/subscriptions", requireSuperAdminAuth, (_req, res) => {
    try {
        res.json(getSubscriptions());
    } catch (err) {
        logger.error('[subscriptions list]', err.message);
        res.status(500).json({ error: 'Failed to fetch subscriptions' });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
//  Background jobs
// ─────────────────────────────────────────────────────────────────────────────

async function autoMarkNoShowsForTenant(tenantId) {
  const db = getDb();
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);

  try {
    const bookings = db.prepare(`
      SELECT id, date, time, endTime, customer_name, phone
      FROM ${tenantId}_bookings
      WHERE status = 'confirmed' AND date <= ?
      ORDER BY date, time
    `).all(todayStr);

    const nowMin = now.getHours() * 60 + now.getMinutes();
    let count = 0;

    for (const b of bookings) {
      const bDate = new Date(b.date);
      const today = new Date(); today.setHours(0, 0, 0, 0); bDate.setHours(0, 0, 0, 0);
      if (bDate > today) continue;

      const [bH, bM] = b.time.split(":").map(Number);
      const bMin = bH * 60 + bM;
      let endMin = bMin + 60;
      if (b.endTime) {
        const [eH, eM] = b.endTime.split(":").map(Number);
        endMin = eH * 60 + eM;
      }

      const isPast = bDate < today;
      const isToday = bDate.getTime() === today.getTime();
      if (!isPast && !(isToday && nowMin > endMin + NO_SHOW_GRACE_MIN)) continue;

      try {
        db.prepare(`UPDATE ${tenantId}_bookings SET status='no_show', updated_at=datetime('now') WHERE id=?`).run(b.id);
        db.prepare(`UPDATE ${tenantId}_staff_bookings SET status='no_show', updated_at=datetime('now') WHERE bookingId=?`).run(b.id);
        db.prepare(`
          INSERT INTO ${tenantId}_customer_metrics (phone, total_bookings, no_shows) VALUES (?, 1, 1)
          ON CONFLICT(phone) DO UPDATE SET no_shows = no_shows + 1, updated_at = datetime('now')
        `).run(b.phone);
        db.prepare(`
          INSERT INTO ${tenantId}_booking_audit (booking_id, old_status, new_status, changed_by, reason)
          VALUES (?, 'confirmed', 'no_show', 'system', 'Auto-marked after grace period')
        `).run(b.id);
        count++;
        const updated = db.prepare(`SELECT * FROM ${tenantId}_bookings WHERE id = ?`).get(b.id);
        await patchCache(tenantId, "bookings", "upsert", updated).catch((e) =>
          logger.error("[cache] no-show:", e.message)
        );
      } catch (e) {
        logger.error(`[NO-SHOW] Booking ${b.id}:`, e.message);
      }
    }
    if (count > 0) logger.info(`[NO-SHOW] ${tenantId}: auto-marked ${count} booking(s)`);
  } catch (e) {
    logger.error(`[NO-SHOW] Scan failed for ${tenantId}:`, e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Super Admin — Integrations Management
// ─────────────────────────────────────────────────────────────────────────────
// Get all salons with their integration status based on plan features
app.get("/super-admin/api/integrations/salons", requireSuperAdminAuth, (req, res) => {
  try {
    const tenants = getAllTenants();
    const result = tenants.map(tenant => {
      // Get the tenant's active subscription with plan details
      const subscription = getTenantSubscription(tenant.tenant_id);
      const config = getWebhookConfig(tenant.tenant_id);

      // Determine if the plan has access to each feature
      const hasWhatsAppAccess = subscription?.whatsapp_access === 1;
      const hasInstagramAccess = subscription?.instagram_access === 1;
      const hasFacebookAccess = subscription?.facebook_access === 1;

      // ✅ FIXED: Connection status requires BOTH token AND (webhook verified OR credentials validated on save)
      const isWhatsAppConnected = hasWhatsAppAccess && !!(config?.wa_access_token && config?.wa_phone_number_id && (config?.wa_webhook_verified || config?.wa_credentials_valid));
      const isInstagramConnected = hasInstagramAccess && !!(config?.ig_page_access_token && (config?.ig_webhook_verified || config?.ig_credentials_valid));
      const isFacebookConnected = hasFacebookAccess && !!(config?.fb_page_access_token && (config?.fb_webhook_verified || config?.fb_credentials_valid));

      // Only show integrations that the plan has access to
      return {
        salon_id: tenant.id,
        salon_name: tenant.salon_name,
        owner_name: tenant.owner_name,
        tenant_id: tenant.tenant_id,
        plan_name: subscription?.plan_name,
        // Features available from plan
        plan_features: {
          whatsapp: hasWhatsAppAccess,
          instagram: hasInstagramAccess,
          facebook: hasFacebookAccess,
          widget: subscription?.widget_access === 1,
          ai_calls: subscription?.ai_calls_access === 1,
        },
        // ✅ FIXED: Actual connection status (requires verification)
        has_whatsapp: isWhatsAppConnected,
        has_instagram: isInstagramConnected,
        has_facebook: isFacebookConnected,
        has_widget: subscription?.widget_access === 1,
        has_ai_calls: subscription?.ai_calls_access === 1 && !!config?.ai_calls_enabled,
        // ✅ FIXED: Show what needs configuration (opposite of connection status)
        needs_configuration: {
          whatsapp: hasWhatsAppAccess && !isWhatsAppConnected,
          instagram: hasInstagramAccess && !isInstagramConnected,
          facebook: hasFacebookAccess && !isFacebookConnected,
        }
      };
    });

    res.json(result);
  } catch (err) {
    logger.error("[super-admin integrations] Error fetching salons:", err.message);
    res.status(500).json({ error: err.message });
  }
});
// Get specific salon integration details

// Get specific salon integration details
app.get("/super-admin/api/integrations/:salonId", requireSuperAdminAuth, (req, res) => {
  try {
    const salonId = parseInt(req.params.salonId);
    const tenants = getAllTenants();
    const tenant = tenants.find(t => t.id === salonId);

    if (!tenant) {
      return res.status(404).json({ error: "Salon not found" });
    }

    const config = getWebhookConfig(tenant.tenant_id);

    res.json({
      whatsapp_phone_number_id: config?.wa_phone_number_id || null,
      whatsapp_access_token: config?.wa_access_token ? "configured" : null,  // never expose actual token
      instagram_access_token: config?.ig_page_access_token ? "configured" : null,
      facebook_access_token: config?.fb_page_access_token ? "configured" : null,

      whatsapp_verify_token: config?.wa_verify_token ? "configured" : null,
      instagram_verify_token: config?.ig_verify_token ? "configured" : null,
      facebook_verify_token: config?.fb_verify_token ? "configured" : null,
      
    });
  } catch (err) {
    logger.error("[super-admin integrations] Error fetching salon details:", err.message);
    res.status(500).json({ error: err.message });
  }
});
// Replace the existing PUT /super-admin/api/integrations/:salonId with:
app.put("/super-admin/api/integrations/:salonId", requireSuperAdminAuth, async (req, res) => {
  try {
    const salonId = parseInt(req.params.salonId);
    const tenants = getAllTenants();
    const tenant = tenants.find(t => t.id === salonId);

    if (!tenant) {
      return res.status(404).json({ error: "Salon not found" });
    }

    upsertWebhookConfig(tenant.tenant_id, {
      wa_phone_number_id: req.body.wa_phone_number_id || undefined,
      wa_access_token: req.body.wa_access_token || undefined,
      wa_verify_token: req.body.wa_verify_token || undefined,
      ig_page_access_token: req.body.ig_page_access_token || undefined,
      ig_verify_token: req.body.ig_verify_token || undefined,
      fb_page_access_token: req.body.fb_page_access_token || undefined,
      fb_verify_token: req.body.fb_verify_token || undefined,
    });

    logger.info(`[super-admin integrations] Updated webhook config for tenant ${tenant.tenant_id}`);

    // Validate credentials against Meta Graph API (fail-open: never abort the save)
    const wantsWhatsapp  = !!(req.body.wa_access_token || req.body.wa_phone_number_id || req.body.wa_verify_token);
    const wantsInstagram = !!(req.body.ig_page_access_token || req.body.ig_verify_token);
    const wantsFacebook  = !!(req.body.fb_page_access_token || req.body.fb_verify_token);
    const validation = {};
    try {
      const stored = getWebhookConfig(tenant.tenant_id) || {};
      if (wantsWhatsapp) {
        const r = await testWhatsAppCredentials({
          phone_number_id: stored.wa_phone_number_id,
          access_token: stored.wa_access_token,
        });
        setCredentialsValid(tenant.tenant_id, 'whatsapp', r.ok);
        validation.whatsapp = r;
        logger.info(`[super-admin integrations] tenant=${tenant.tenant_id} WA credentials_valid=${r.ok}`);
      }
      if (wantsInstagram) {
        const r = await testInstagramCredentials({ page_access_token: stored.ig_page_access_token });
        setCredentialsValid(tenant.tenant_id, 'instagram', r.ok);
        validation.instagram = r;
        logger.info(`[super-admin integrations] tenant=${tenant.tenant_id} IG credentials_valid=${r.ok}`);
      }
      if (wantsFacebook) {
        const r = await testFacebookCredentials({ page_access_token: stored.fb_page_access_token });
        setCredentialsValid(tenant.tenant_id, 'facebook', r.ok);
        validation.facebook = r;
        logger.info(`[super-admin integrations] tenant=${tenant.tenant_id} FB credentials_valid=${r.ok}`);
      }
    } catch (err) {
      logger.error(`[super-admin integrations] credential test failed for ${tenant.tenant_id}: ${err.message}`);
      // Never abort the save — credentials stay stored, validation remains absent/false.
    }

    res.json({ success: true, validation });

  } catch (err) {
    logger.error("[super-admin integrations] Error updating integration:", err.message);
    res.status(500).json({ error: err.message });
  }
});
// Delete/clear a specific channel's integration for a salon
app.delete("/super-admin/api/integrations/:salonId/:channel", requireSuperAdminAuth, (req, res) => {
  try {
    const salonId = parseInt(req.params.salonId);
    const { channel } = req.params;

    if (!["whatsapp", "instagram", "facebook"].includes(channel)) {
      return res.status(400).json({ error: "Invalid channel. Must be: whatsapp, instagram, or facebook" });
    }

    const tenants = getAllTenants();
    const tenant = tenants.find(t => t.id === salonId);

    if (!tenant) {
      return res.status(404).json({ error: "Salon not found" });
    }

    clearWebhookChannel(tenant.tenant_id, channel);

    logger.info(`[super-admin] Cleared ${channel} integration for tenant ${tenant.tenant_id}`);
    res.json({ success: true, message: `${channel} integration cleared` });

  } catch (err) {
    logger.error("[super-admin integrations] Error deleting channel:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get all subscriptions for super admin
app.get("/super-admin/api/subscriptions", requireSuperAdminAuth, (_req, res) => {
  try {
    const subscriptions = getSubscriptions();
    // Enrich with tenant and plan details
    const enriched = subscriptions.map(sub => {
      const tenant = getTenantById(sub.tenant_id);
      const plan = getPlanById(sub.plan_id);
      return {
        ...sub,
        tenant_name: tenant?.salon_name || "Unknown",
        tenant_email: tenant?.email || "Unknown",
        plan_name: plan?.name || "Unknown",
      };
    });
    res.json(enriched);
  } catch (err) {
    logger.error("[super-admin subscriptions] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get plan features for a specific tenant (super admin view)
app.get("/super-admin/api/tenants/:tenantId/plan-features", requireSuperAdminAuth, (req, res) => {
  try {
    const { tenantId } = req.params;
    const sub = getTenantSubscription(tenantId);

    if (!sub) {
      return res.json({
        max_services: 10,
        whatsapp_access: 0,
        instagram_access: 0,
        facebook_access: 0,
        widget_access: 0,
        ai_calls_access: 0,
      });
    }

    const plan = getPlanById(sub.plan_id);
    res.json({
      max_services: plan?.max_services || 10,
      whatsapp_access: plan?.whatsapp_access || 0,
      instagram_access: plan?.instagram_access || 0,
      facebook_access: plan?.facebook_access || 0,
      widget_access: plan?.widget_access || 0,
      ai_calls_access: plan?.ai_calls_access || 0,
    });
  } catch (err) {
    logger.error("[super-admin plan-features] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

async function sendRemindersForTenant(tenantId) {
  const db = getDb();
  const setting = db.prepare(`SELECT value FROM ${tenantId}_business_settings WHERE key='reminder_hours'`).get();
  const reminderHours = setting ? parseInt(setting.value) : 24;
  const target = new Date(); target.setHours(target.getHours() + reminderHours);
  const targetDate = target.toISOString().slice(0, 10);

  const bookings = db.prepare(`
    SELECT * FROM ${tenantId}_bookings
    WHERE status='confirmed' AND date=? AND reminder_sent=0
  `).all(targetDate);

  for (const b of bookings) {
    try {
      logger.info(`[REMINDER] ${tenantId} → ${b.phone}: ${b.time} ${b.service} @ ${b.branch}`);
      db.prepare(`UPDATE ${tenantId}_bookings SET reminder_sent=1 WHERE id=?`).run(b.id);
    } catch (e) {
      logger.error(`[REMINDER] Booking ${b.id}:`, e.message);
    }
  }
}

async function runJobsForAllTenants() {
  try {
    const tenants = getAllTenants();
    for (const t of tenants.filter((t) => t.status === "active")) {
      await sendRemindersForTenant(t.tenant_id).catch((e) =>
        logger.error(`[JOB] Reminders ${t.tenant_id}:`, e.message)
      );
      await autoMarkNoShowsForTenant(t.tenant_id).catch((e) =>
        logger.error(`[JOB] No-shows ${t.tenant_id}:`, e.message)
      );
    }
  } catch (e) {
    logger.error("[JOB] Failed:", e.message);
  }
}



// In index.js - Add for testing
app.post("/test-email", async (req, res) => {
  try {
    const { sendPlanUpgradeEmail } = require('./services/emailService');
    await sendPlanUpgradeEmail({
      to: "alyan@sigmasqr.com",
      ownerName: "Test Owner",
      salonName: "Test Salon",
      oldPlanName: "Free",
      newPlanName: "Pro",
      amount: "$20",
      billingCycle: "month",
      nextBillingDate: new Date().toLocaleDateString(),
    });
    res.json({ success: true, message: "Email sent" });
  } catch (err) {
    console.error("Email error:", err);
    res.json({ success: false, error: err.message });
  }
});

// In index.js - Add this to test Gmail directly
app.get("/test-gmail-connection", async (req, res) => {
  const nodemailer = require('nodemailer');

  const config = {
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_PORT === '465',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  };

  console.log("Testing Gmail with config:", {
    host: config.host,
    port: config.port,
    secure: config.secure,
    user: config.auth.user,
    hasPass: !!config.auth.pass
  });

  try {
    const transporter = nodemailer.createTransport(config);

    // Verify connection
    await transporter.verify();
    console.log("✅ SMTP connection successful");

    // Try to send a test email
    const info = await transporter.sendMail({
      from: process.env.SMTP_FROM || `"Test" <${config.auth.user}>`,
      to: config.auth.user,
      subject: "Gmail SMTP Test - " + new Date().toLocaleString(),
      text: "If you receive this, your email is working!",
      html: "<h1>✅ Success!</h1><p>Your Gmail SMTP configuration is working correctly.</p>",
    });

    console.log("✅ Email sent:", info.messageId);
    res.json({
      success: true,
      message: "Email sent! Check your inbox",
      messageId: info.messageId
    });

  } catch (err) {
    console.error("❌ Email error:", err.message);
    res.json({
      success: false,
      error: err.message,
      code: err.code,
      command: err.command
    });
  }
});

app.get("/check-app-password", async (req, res) => {
  const { google } = require('googleapis');

  const oauth2Client = new google.auth.OAuth2();
  oauth2Client.setCredentials({
    refresh_token: process.env.GMAIL_REFRESH_TOKEN // Not applicable for App Password
  });

  res.json({
    message: "App Password authentication is tested via SMTP, not OAuth",
    test_endpoint: "/test-gmail-connection"
  });
});
// ─────────────────────────────────────────────────────────────────────────────
//  Server startup
// ─────────────────────────────────────────────────────────────────────────────

const server = http.createServer(app);
setupCallServer(server);

server.listen(PORT, async () => {
  logger.info(`Salon Bot server running on port ${PORT}`);
  await initializeAllTenants();
  getDb(); // ensure schema initialised

  // PLN-02 startup backfill: freeze excess services for any tenant whose service
  // count exceeds their current plan limit. This is a no-op for tenants already
  // within their limit, and is idempotent on every restart.
  // Needed because the frozen column was added with DEFAULT 0, so tenants whose
  // plan was already set before Phase 2 had freezeExcessServices() never called.
  try {
    const allTenants = getAllTenants();
    for (const t of allTenants.filter((t) => t.status === "active")) {
      const sub = getTenantSubscription(t.tenant_id);
      if (sub && Number.isFinite(sub.max_services)) {
        const frozen = freezeExcessServices(t.tenant_id, sub.max_services);
        if (frozen > 0) {
          logger.info(`[startup] Froze ${frozen} excess services for ${t.tenant_id} (plan limit=${sub.max_services})`);
        }
      }
    }
    logger.info("[startup] Plan limit enforcement backfill complete");
  } catch (e) {
    logger.warn("[startup] Plan limit enforcement backfill failed:", e.message);
  }

  // Optional migration
  // if (process.env.RUN_MIGRATION === "true") {
  //   const { migrateToMultiTenant } = require("./scripts/migrate-to-multitenant");
  //   migrateToMultiTenant().catch(console.error);
  // }

  // Pre-warm caches for all active tenants
  try {
    const tenants = getAllTenants();
    for (const t of tenants.filter((t) => t.status === "active")) {
      // Check if tenant has any staff before caching
      const db = getDb();
      const staffCount = db.prepare(`SELECT COUNT(*) as count FROM ${t.tenant_id}_staff`).get();
      const serviceCount = db.prepare(`SELECT COUNT(*) as count FROM ${t.tenant_id}_services`).get();

      console.log(`Tenant ${t.tenant_id}: Staff=${staffCount.count}, Services=${serviceCount.count}`);

      // Only initialize cache if there's data, otherwise skip
      if (staffCount.count > 0 || serviceCount.count > 0) {
        await initCache(t.tenant_id).catch((e) =>
          logger.error(`[cache] init ${t.tenant_id}:`, e.message)
        );
      } else {
        logger.info(`[cache] Skipping cache for ${t.tenant_id} - no data yet`);
      }
    }
    logger.info(`[cache] Warmed caches for tenants with data`);
  } catch (e) {
    logger.warn("[cache] Could not warm tenant caches on startup:", e.message);
  }

  // Initial no-show scan after 5 s
  setTimeout(() => runJobsForAllTenants(), 5_000);

  // Periodic jobs — every 15 min only (was incorrectly double-scheduled before)
  setInterval(() => runJobsForAllTenants(), NO_SHOW_SCAN_MS);

  logger.info("Server started successfully ✅");
});