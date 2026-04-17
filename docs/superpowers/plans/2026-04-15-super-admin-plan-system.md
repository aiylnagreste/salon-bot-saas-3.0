# Super Admin & Salon Admin Plan System — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build complete Plan Management (Super Admin), Stripe-gated public registration, email notifications, and secure forgot/reset password for Salon Admins.

**Architecture:** Super Admin creates plans with feature flags stored in `super.db`. Salon Admins register via a public Next.js page, choose a plan, pay via Stripe Checkout (redirect), and on successful webhook the backend creates their tenant account and sends a welcome email. Forgot password uses a DB-persisted token with 5-minute expiry sent via email link.

**Tech Stack:** Express + better-sqlite3 (backend), Next.js 16 + Tailwind v4 + TanStack Query (frontend), Stripe Node SDK, Nodemailer (SMTP), Lucide React icons, Zod + react-hook-form

---

## Scope Note

This plan covers 4 independent subsystems that build on each other in this order:
1. DB schema + Plans CRUD
2. Email service
3. Stripe registration flow
4. Forgot/reset password

---

## File Map

### Backend — New/Modified Files
| File | Action | Responsibility |
|------|--------|---------------|
| `src/db/tenantManager.js` | Modify | Add `plans`, `subscriptions`, `password_reset_tokens` tables + CRUD fns |
| `src/services/emailService.js` | Create | Nodemailer wrapper, welcome email, reset email templates |
| `src/services/stripeService.js` | Create | Stripe SDK wrapper, checkout session creation, plan sync |
| `src/index.js` | Modify | Add plan CRUD routes, public registration, Stripe webhook, proper reset password routes |

### Frontend — New Files
| File | Action | Responsibility |
|------|--------|---------------|
| `app/api/public/plans/route.ts` | Create | Proxy GET /api/public/plans |
| `app/api/register/route.ts` | Create | Proxy POST /api/register → returns Stripe checkout URL |
| `app/api/stripe/webhook/route.ts` | Create | Proxy POST /api/stripe/webhook |
| `app/api/super-admin/plans/route.ts` | Create | Proxy super admin plan CRUD |
| `app/api/super-admin/plans/[id]/route.ts` | Create | Proxy plan update/delete |
| `app/api/super-admin/payments/route.ts` | Create | Proxy GET subscriptions |
| `app/api/forgot-password/route.ts` | Create | Proxy POST /tenant/forgot-password |
| `app/api/reset-password/route.ts` | Create | Proxy POST /tenant/reset-password |
| `app/(public)/register/page.tsx` | Create | Public salon registration with plan selection |
| `app/(public)/layout.tsx` | Create | Minimal layout for public pages (no sidebar) |
| `app/(auth)/forgot-password/page.tsx` | Create | Forgot password request form |
| `app/(auth)/reset-password/page.tsx` | Create | Reset password form (reads `?token=` from URL) |
| `app/(super)/super-admin/plans/page.tsx` | Create | Super admin plans management |
| `app/(super)/super-admin/payments/page.tsx` | Create | Super admin subscriptions/payments view |
| `lib/types.ts` | Modify | Add Plan, Subscription, PublicPlan types |
| `lib/queries.ts` | Modify | Add fetchPlans, fetchSubscriptions query fns |

### Frontend — Modified Files
| File | Action | What changes |
|------|--------|-------------|
| `app/(super)/super-admin/dashboard/page.tsx` | Modify | Add Plans + Payments links to sidebar / nav |

---

## Environment Variables

### Backend (Railway)
```
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=noreply@example.com
SMTP_PASS=yourpassword
SMTP_FROM="SalonBot <noreply@example.com>"
FRONTEND_URL=https://your-vercel-app.vercel.app
```

### Frontend (Vercel)
```
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_live_...
# BACKEND_URL already exists
```

---

## Task 1: DB Schema — plans, subscriptions, password_reset_tokens

**Files:**
- Modify: `src/db/tenantManager.js`

- [ ] **Step 1: Add `plans` table creation inside `initSuperSchema()`**

In `src/db/tenantManager.js`, inside `initSuperSchema()` after the `super_admin_audit` block, add:

```javascript
// Plans table
superDb.exec(`
    CREATE TABLE IF NOT EXISTS plans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT,
        price_cents INTEGER NOT NULL DEFAULT 0,
        billing_cycle TEXT NOT NULL DEFAULT 'monthly',
        max_services INTEGER NOT NULL DEFAULT 10,
        whatsapp_access INTEGER NOT NULL DEFAULT 0,
        instagram_access INTEGER NOT NULL DEFAULT 0,
        facebook_access INTEGER NOT NULL DEFAULT 0,
        ai_calls_access INTEGER NOT NULL DEFAULT 0,
        stripe_price_id TEXT,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
    )
`);

// Subscriptions table
superDb.exec(`
    CREATE TABLE IF NOT EXISTS subscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id TEXT NOT NULL REFERENCES salon_tenants(tenant_id) ON DELETE CASCADE,
        plan_id INTEGER NOT NULL REFERENCES plans(id),
        stripe_subscription_id TEXT UNIQUE,
        stripe_customer_id TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        current_period_start TEXT,
        current_period_end TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
    )
`);

// Password reset tokens
superDb.exec(`
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        used INTEGER NOT NULL DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
    )
`);
```

- [ ] **Step 2: Add helper functions for plans at the bottom of `tenantManager.js`**

```javascript
// ── Plans ─────────────────────────────────────────────────────────────────────

function getAllPlans() {
    const db = getSuperDb();
    return db.prepare(`SELECT * FROM plans ORDER BY price_cents ASC`).all();
}

function getActivePlans() {
    const db = getSuperDb();
    return db.prepare(`SELECT * FROM plans WHERE is_active = 1 ORDER BY price_cents ASC`).all();
}

function getPlanById(planId) {
    const db = getSuperDb();
    return db.prepare(`SELECT * FROM plans WHERE id = ?`).get(planId);
}

function createPlan(data) {
    const db = getSuperDb();
    const { name, description, price_cents, billing_cycle, max_services,
            whatsapp_access, instagram_access, facebook_access, ai_calls_access,
            stripe_price_id } = data;
    const result = db.prepare(`
        INSERT INTO plans (name, description, price_cents, billing_cycle, max_services,
            whatsapp_access, instagram_access, facebook_access, ai_calls_access, stripe_price_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(name, description || null, price_cents, billing_cycle || 'monthly',
           max_services, whatsapp_access ? 1 : 0, instagram_access ? 1 : 0,
           facebook_access ? 1 : 0, ai_calls_access ? 1 : 0, stripe_price_id || null);
    return getPlanById(result.lastInsertRowid);
}

function updatePlan(planId, data) {
    const db = getSuperDb();
    const fields = [];
    const values = [];
    const allowed = ['name','description','price_cents','billing_cycle','max_services',
                     'whatsapp_access','instagram_access','facebook_access','ai_calls_access',
                     'stripe_price_id','is_active'];
    for (const key of allowed) {
        if (data[key] !== undefined) {
            fields.push(`${key} = ?`);
            values.push(typeof data[key] === 'boolean' ? (data[key] ? 1 : 0) : data[key]);
        }
    }
    if (!fields.length) return getPlanById(planId);
    fields.push(`updated_at = datetime('now')`);
    values.push(planId);
    db.prepare(`UPDATE plans SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    return getPlanById(planId);
}

function deletePlan(planId) {
    const db = getSuperDb();
    db.prepare(`UPDATE plans SET is_active = 0, updated_at = datetime('now') WHERE id = ?`).run(planId);
}

// ── Subscriptions ─────────────────────────────────────────────────────────────

function createSubscription(tenantId, planId, stripeSubId, stripeCustomerId, periodStart, periodEnd) {
    const db = getSuperDb();
    db.prepare(`
        INSERT INTO subscriptions (tenant_id, plan_id, stripe_subscription_id, stripe_customer_id,
            status, current_period_start, current_period_end)
        VALUES (?, ?, ?, ?, 'active', ?, ?)
    `).run(tenantId, planId, stripeSubId || null, stripeCustomerId || null,
           periodStart || null, periodEnd || null);
}

function getSubscriptions() {
    const db = getSuperDb();
    return db.prepare(`
        SELECT s.*, st.salon_name, st.owner_name, st.email, p.name as plan_name, p.price_cents, p.billing_cycle
        FROM subscriptions s
        JOIN salon_tenants st ON st.tenant_id = s.tenant_id
        JOIN plans p ON p.id = s.plan_id
        ORDER BY s.created_at DESC
    `).all();
}

// ── Password Reset Tokens ─────────────────────────────────────────────────────

function storeResetToken(tenantId, tokenHash, expiresAt) {
    const db = getSuperDb();
    // Invalidate any existing tokens for this tenant
    db.prepare(`DELETE FROM password_reset_tokens WHERE tenant_id = ?`).run(tenantId);
    db.prepare(`
        INSERT INTO password_reset_tokens (tenant_id, token_hash, expires_at)
        VALUES (?, ?, ?)
    `).run(tenantId, tokenHash, expiresAt);
}

function getValidResetToken(tokenHash) {
    const db = getSuperDb();
    return db.prepare(`
        SELECT * FROM password_reset_tokens
        WHERE token_hash = ? AND used = 0 AND expires_at > datetime('now')
    `).get(tokenHash);
}

function markResetTokenUsed(tokenHash) {
    const db = getSuperDb();
    db.prepare(`UPDATE password_reset_tokens SET used = 1 WHERE token_hash = ?`).run(tokenHash);
}
```

- [ ] **Step 3: Export the new functions from `tenantManager.js`**

Find the existing `module.exports = { ... }` block and add the new functions:

```javascript
module.exports = {
    // ... existing exports ...
    getSuperDb,
    markWebhookVerified,
    createTenant,
    authenticateTenant,
    getTenantByEmail,
    getTenantById,
    getAllTenants,
    updateTenantStatus,
    updateTenantPassword,
    changeSuperAdminPassword,
    updateSalonName,
    getTenantSetting,
    setTenantSetting,
    isTenantActive,
    getWebhookConfig,
    upsertWebhookConfig,
    clearWebhookChannel,
    // New exports:
    getAllPlans,
    getActivePlans,
    getPlanById,
    createPlan,
    updatePlan,
    deletePlan,
    createSubscription,
    getSubscriptions,
    storeResetToken,
    getValidResetToken,
    markResetTokenUsed,
};
```

- [ ] **Step 4: Restart backend and verify tables created**

```bash
cd "d:/vs self code/salon-bot"
node -e "require('./src/db/tenantManager'); console.log('schema ok')"
```
Expected: `schema ok` with no errors.

- [ ] **Step 5: Commit**

```bash
git add src/db/tenantManager.js
git commit -m "feat: add plans, subscriptions, password_reset_tokens tables"
```

---

## Task 2: Install Backend Dependencies

**Files:**
- `package.json` (updated by npm)

- [ ] **Step 1: Install stripe and nodemailer**

```bash
cd "d:/vs self code/salon-bot"
npm install stripe nodemailer
```
Expected: `added 2 packages` (or similar).

- [ ] **Step 2: Verify installation**

```bash
node -e "require('stripe'); require('nodemailer'); console.log('deps ok')"
```
Expected: `deps ok`

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat: add stripe and nodemailer dependencies"
```

---

## Task 3: Email Service

**Files:**
- Create: `src/services/emailService.js`

- [ ] **Step 1: Create the email service file**

Create `src/services/emailService.js`:

```javascript
"use strict";
const nodemailer = require('nodemailer');

function createTransport() {
    return nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT || '587', 10),
        secure: process.env.SMTP_PORT === '465',
        auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS,
        },
    });
}

/**
 * Send welcome email to new salon admin after successful payment.
 */
async function sendWelcomeEmail({ to, ownerName, salonName, email, password, loginUrl }) {
    const transport = createTransport();
    await transport.sendMail({
        from: process.env.SMTP_FROM || '"SalonBot" <noreply@salonbot.com>',
        to,
        subject: `Welcome to SalonBot — Your account is ready`,
        html: `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
        <tr>
          <td style="background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);padding:36px 40px;text-align:center;">
            <h1 style="color:#fff;margin:0;font-size:24px;font-weight:700;">Welcome to SalonBot!</h1>
            <p style="color:rgba(255,255,255,0.85);margin:8px 0 0;font-size:14px;">Your salon management platform is ready</p>
          </td>
        </tr>
        <tr>
          <td style="padding:36px 40px;">
            <p style="color:#374151;font-size:15px;margin:0 0 24px;">Hi ${ownerName},</p>
            <p style="color:#374151;font-size:15px;margin:0 0 24px;">
              Your <strong>${salonName}</strong> account has been successfully created. 
              Here are your login credentials:
            </p>
            <table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;border-radius:8px;padding:20px;margin-bottom:28px;">
              <tr><td>
                <p style="margin:0 0 8px;font-size:13px;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;font-weight:600;">Login Email</p>
                <p style="margin:0 0 16px;font-size:16px;color:#1e293b;font-weight:500;">${email}</p>
                <p style="margin:0 0 8px;font-size:13px;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;font-weight:600;">Temporary Password</p>
                <p style="margin:0;font-size:16px;color:#1e293b;font-weight:500;font-family:monospace;letter-spacing:0.1em;">${password}</p>
              </td></tr>
            </table>
            <p style="color:#6b7280;font-size:13px;margin:0 0 24px;">
              Please change your password after your first login for security.
            </p>
            <a href="${loginUrl}" style="display:inline-block;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:15px;font-weight:600;">
              Login to Dashboard
            </a>
          </td>
        </tr>
        <tr>
          <td style="padding:20px 40px 28px;border-top:1px solid #f1f5f9;">
            <p style="margin:0;font-size:12px;color:#9ca3af;text-align:center;">
              This email was sent by SalonBot. If you didn't sign up, please ignore this email.
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
    });
}

/**
 * Send password reset email with a secure link.
 */
async function sendPasswordResetEmail({ to, ownerName, resetUrl }) {
    const transport = createTransport();
    await transport.sendMail({
        from: process.env.SMTP_FROM || '"SalonBot" <noreply@salonbot.com>',
        to,
        subject: `Reset your SalonBot password`,
        html: `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
        <tr>
          <td style="background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);padding:36px 40px;text-align:center;">
            <h1 style="color:#fff;margin:0;font-size:24px;font-weight:700;">Password Reset</h1>
            <p style="color:rgba(255,255,255,0.85);margin:8px 0 0;font-size:14px;">This link expires in 5 minutes</p>
          </td>
        </tr>
        <tr>
          <td style="padding:36px 40px;">
            <p style="color:#374151;font-size:15px;margin:0 0 20px;">Hi ${ownerName},</p>
            <p style="color:#374151;font-size:15px;margin:0 0 28px;">
              We received a request to reset your SalonBot password. Click the button below to set a new password.
              This link will expire in <strong>5 minutes</strong>.
            </p>
            <a href="${resetUrl}" style="display:inline-block;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:15px;font-weight:600;">
              Reset Password
            </a>
            <p style="color:#6b7280;font-size:13px;margin:24px 0 0;">
              If you didn't request a password reset, you can safely ignore this email. Your password won't be changed.
            </p>
          </td>
        </tr>
        <tr>
          <td style="padding:20px 40px 28px;border-top:1px solid #f1f5f9;">
            <p style="margin:0;font-size:12px;color:#9ca3af;text-align:center;">
              SalonBot · <a href="${process.env.FRONTEND_URL}" style="color:#9ca3af;">${process.env.FRONTEND_URL}</a>
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
    });
}

module.exports = { sendWelcomeEmail, sendPasswordResetEmail };
```

- [ ] **Step 2: Verify the file loads without SMTP env vars**

```bash
cd "d:/vs self code/salon-bot"
node -e "require('./src/services/emailService'); console.log('email service ok')"
```
Expected: `email service ok`

- [ ] **Step 3: Commit**

```bash
git add src/services/emailService.js
git commit -m "feat: add email service with welcome and password reset templates"
```

---

## Task 4: Stripe Service

**Files:**
- Create: `src/services/stripeService.js`

- [ ] **Step 1: Create the Stripe service**

Create `src/services/stripeService.js`:

```javascript
"use strict";

function getStripe() {
    if (!process.env.STRIPE_SECRET_KEY) {
        throw new Error('STRIPE_SECRET_KEY not set');
    }
    const Stripe = require('stripe');
    return Stripe(process.env.STRIPE_SECRET_KEY);
}

/**
 * Create a Stripe Checkout Session for a plan subscription.
 * @param {object} params
 * @param {string} params.planId - internal plan id
 * @param {string} params.stripePriceId - Stripe Price ID
 * @param {string} params.email - customer email
 * @param {string} params.ownerName - customer name
 * @param {string} params.salonName - salon name
 * @param {string} params.phone - phone number
 * @param {string} params.successUrl - URL after payment success (include ?session_id={CHECKOUT_SESSION_ID})
 * @param {string} params.cancelUrl - URL if customer cancels
 * @param {string} params.registrationData - JSON stringified extra data stored in metadata
 */
async function createCheckoutSession({ planId, stripePriceId, email, ownerName, salonName, phone, successUrl, cancelUrl, registrationData }) {
    const stripe = getStripe();
    const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        payment_method_types: ['card'],
        customer_email: email,
        line_items: [{ price: stripePriceId, quantity: 1 }],
        success_url: successUrl,
        cancel_url: cancelUrl,
        metadata: {
            plan_id: String(planId),
            owner_name: ownerName,
            salon_name: salonName,
            phone,
            registration_data: registrationData || '',
        },
        subscription_data: {
            metadata: {
                plan_id: String(planId),
                salon_name: salonName,
            },
        },
    });
    return session;
}

/**
 * Construct and verify a Stripe webhook event.
 */
function constructWebhookEvent(payload, signature) {
    const stripe = getStripe();
    return stripe.webhooks.constructEvent(
        payload,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET
    );
}

module.exports = { createCheckoutSession, constructWebhookEvent };
```

- [ ] **Step 2: Verify the file loads**

```bash
node -e "require('./src/services/stripeService'); console.log('stripe service ok')"
```
Expected: `stripe service ok`

- [ ] **Step 3: Commit**

```bash
git add src/services/stripeService.js
git commit -m "feat: add Stripe service for checkout session + webhook verification"
```

---

## Task 5: Backend — Plans CRUD Routes

**Files:**
- Modify: `src/index.js`

- [ ] **Step 1: Import new functions at top of `src/index.js`**

Find the existing destructuring import from `./db/tenantManager` and add the new functions:

```javascript
const {
  getSuperDb,
  getAllTenants,
  createTenant,
  updateTenantStatus,
  authenticateTenant,
  getTenantById,
  updateSalonName,
  isTenantActive,
  getWebhookConfig,
  upsertWebhookConfig,
  clearWebhookChannel,
  updateTenantPassword,
  changeSuperAdminPassword,
  // New:
  getAllPlans,
  getActivePlans,
  getPlanById,
  createPlan,
  updatePlan,
  deletePlan,
  createSubscription,
  getSubscriptions,
  storeResetToken,
  getValidResetToken,
  markResetTokenUsed,
} = require("./db/tenantManager");
```

Also add service imports near the top of `src/index.js`:

```javascript
const { sendWelcomeEmail, sendPasswordResetEmail } = require('./services/emailService');
const { createCheckoutSession, constructWebhookEvent } = require('./services/stripeService');
```

- [ ] **Step 2: Add Plans CRUD routes to `src/index.js`**

Find the block starting with `app.get("/super-admin/api/stats"` and add the plans routes after the existing super-admin routes block (after the `app.put("/super-admin/api/change-password"` route):

```javascript
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
            whatsapp_access, instagram_access, facebook_access, ai_calls_access } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    if (price_cents === undefined || price_cents === null)
        return res.status(400).json({ error: 'price_cents is required' });
    try {
        const plan = createPlan({
            name, description, price_cents: parseInt(price_cents, 10),
            billing_cycle: billing_cycle || 'monthly',
            max_services: parseInt(max_services || 10, 10),
            whatsapp_access: !!whatsapp_access,
            instagram_access: !!instagram_access,
            facebook_access: !!facebook_access,
            ai_calls_access: !!ai_calls_access,
        });
        res.status(201).json(plan);
    } catch (err) {
        logger.error('[plan create]', err.message);
        res.status(500).json({ error: 'Failed to create plan' });
    }
});

app.put("/super-admin/api/plans/:planId", requireSuperAdminAuth, (req, res) => {
    const planId = parseInt(req.params.planId, 10);
    const plan = getPlanById(planId);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    try {
        const updated = updatePlan(planId, req.body);
        res.json(updated);
    } catch (err) {
        logger.error('[plan update]', err.message);
        res.status(500).json({ error: 'Failed to update plan' });
    }
});

app.delete("/super-admin/api/plans/:planId", requireSuperAdminAuth, (req, res) => {
    const planId = parseInt(req.params.planId, 10);
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

app.get("/super-admin/api/subscriptions", requireSuperAdminAuth, (_req, res) => {
    try {
        res.json(getSubscriptions());
    } catch (err) {
        logger.error('[subscriptions list]', err.message);
        res.status(500).json({ error: 'Failed to fetch subscriptions' });
    }
});
```

- [ ] **Step 3: Test plans routes with curl (dev server must be running)**

```bash
# In a separate terminal, start the server:
# npm run dev

# Then test (replace COOKIE with actual superAdminToken after login):
curl -s http://localhost:3000/super-admin/api/plans \
  -H "Cookie: superAdminToken=YOUR_TOKEN" | head -50
```
Expected: `[]` (empty array, no plans yet) or a JSON array.

- [ ] **Step 4: Commit**

```bash
git add src/index.js
git commit -m "feat: add super admin plans CRUD and subscriptions API routes"
```

---

## Task 6: Backend — Public Registration + Stripe Checkout

**Files:**
- Modify: `src/index.js`

- [ ] **Step 1: Add raw body middleware for Stripe webhook**

Find the `app.use(express.json())` line near the top and replace with:

```javascript
// Raw body needed for Stripe webhook signature verification
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
```

- [ ] **Step 2: Add public plans endpoint and registration endpoint**

Add these routes near the top of the route definitions (before `requireSuperAdminAuth` routes):

```javascript
// ── Public — Plan listing for registration page ───────────────────────────────

app.get("/api/public/plans", (_req, res) => {
    try {
        const plans = getActivePlans();
        // Expose safe fields only (no stripe_price_id to public)
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

// ── Public — Initiate registration via Stripe Checkout ───────────────────────

app.post("/api/register", async (req, res) => {
    const { owner_name, salon_name, email, phone, plan_id } = req.body;
    if (!owner_name || !salon_name || !email || !phone || !plan_id)
        return res.status(400).json({ error: 'owner_name, salon_name, email, phone, plan_id are required' });

    // Validate email format
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        return res.status(400).json({ error: 'Invalid email address' });

    // Check duplicate email
    const { getTenantByEmail } = require('./db/tenantManager');
    const existing = getTenantByEmail(email);
    if (existing) return res.status(409).json({ error: 'An account with this email already exists' });

    const plan = getPlanById(plan_id);
    if (!plan || !plan.is_active)
        return res.status(404).json({ error: 'Plan not found or inactive' });

    // If plan is free (price_cents === 0), create tenant directly
    if (plan.price_cents === 0) {
        try {
            const crypto = require('crypto');
            const generatedPassword = crypto.randomBytes(8).toString('hex');
            const tenantId = await createTenant(owner_name, salon_name, email, phone, generatedPassword);
            createSubscription(tenantId, plan.id, null, null, null, null);
            const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3002';
            await sendWelcomeEmail({
                to: email,
                ownerName: owner_name,
                salonName: salon_name,
                email,
                password: generatedPassword,
                loginUrl: `${frontendUrl}/login`,
            }).catch(err => logger.warn('[welcome email]', err.message));
            return res.json({ ok: true, redirect: `${frontendUrl}/login?registered=1` });
        } catch (err) {
            logger.error('[free register]', err.message);
            return res.status(500).json({ error: 'Registration failed' });
        }
    }

    // Paid plan — require stripe_price_id
    if (!plan.stripe_price_id)
        return res.status(400).json({ error: 'This plan is not yet available for purchase. Please contact support.' });

    try {
        const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3002';
        const session = await createCheckoutSession({
            planId: plan.id,
            stripePriceId: plan.stripe_price_id,
            email,
            ownerName: owner_name,
            salonName: salon_name,
            phone,
            successUrl: `${frontendUrl}/register/success?session_id={CHECKOUT_SESSION_ID}`,
            cancelUrl: `${frontendUrl}/register?cancelled=1`,
            registrationData: JSON.stringify({ owner_name, salon_name, email, phone, plan_id }),
        });
        res.json({ checkout_url: session.url });
    } catch (err) {
        logger.error('[stripe checkout]', err.message);
        res.status(500).json({ error: 'Payment initiation failed. Please try again.' });
    }
});
```

- [ ] **Step 3: Add Stripe webhook handler**

```javascript
// ── Stripe Webhook ─────────────────────────────────────────────────────────────

app.post("/api/stripe/webhook", async (req, res) => {
    const signature = req.headers['stripe-signature'];
    if (!signature)
        return res.status(400).json({ error: 'Missing stripe-signature header' });

    let event;
    try {
        event = constructWebhookEvent(req.body, signature);
    } catch (err) {
        logger.error('[stripe webhook] signature verification failed:', err.message);
        return res.status(400).json({ error: `Webhook error: ${err.message}` });
    }

    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const meta = session.metadata || {};
        const { owner_name, salon_name, phone, plan_id } = meta;
        const email = session.customer_email || meta.email;

        if (!email || !owner_name || !salon_name) {
            logger.warn('[stripe webhook] missing metadata in session:', session.id);
            return res.json({ received: true });
        }

        // Idempotency: skip if tenant already exists
        const { getTenantByEmail } = require('./db/tenantManager');
        const existing = getTenantByEmail(email);
        if (existing) {
            logger.info(`[stripe webhook] tenant already exists for ${email}, skipping`);
            return res.json({ received: true });
        }

        try {
            const crypto = require('crypto');
            const generatedPassword = crypto.randomBytes(8).toString('hex');
            const tenantId = await createTenant(owner_name, salon_name, email, phone || '', generatedPassword);

            const periodStart = session.subscription ? null : null; // retrieved below
            const stripeSubId = session.subscription || null;
            const stripeCustomerId = session.customer || null;
            const planIdNum = parseInt(plan_id || '0', 10);

            if (planIdNum) {
                createSubscription(tenantId, planIdNum, stripeSubId, stripeCustomerId, null, null);
            }

            const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3002';
            await sendWelcomeEmail({
                to: email,
                ownerName: owner_name,
                salonName: salon_name,
                email,
                password: generatedPassword,
                loginUrl: `${frontendUrl}/login`,
            });

            logger.info(`[stripe webhook] tenant ${tenantId} created for ${email}`);
        } catch (err) {
            logger.error('[stripe webhook] tenant creation error:', err.message);
            // Return 200 so Stripe doesn't retry — log for manual recovery
        }
    }

    res.json({ received: true });
});
```

- [ ] **Step 4: Commit**

```bash
git add src/index.js
git commit -m "feat: add public registration, Stripe checkout, and webhook handler"
```

---

## Task 7: Backend — Forgot Password + Reset Password (DB-Persisted)

**Files:**
- Modify: `src/index.js`

> Replace the existing in-memory `POST /salon-admin/reset-request` with a proper DB-persisted token flow.

- [ ] **Step 1: Find and replace the in-memory reset endpoint**

Find the existing block:
```javascript
// resetRequests[tenantId] = { email, salonName, requestedAt }
const resetRequests = {};

// Public: salon admin submits "forgot password" request
app.post("/salon-admin/reset-request", (req, res) => {
```

Replace the entire block (including `resetRequests` declaration and the route) with:

```javascript
// ── Tenant Auth — Forgot / Reset Password ────────────────────────────────────

app.post("/tenant/forgot-password", async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'email required' });

    // Always 200 to avoid leaking whether email exists
    res.json({ ok: true });

    // Fire-and-forget after response
    setImmediate(async () => {
        try {
            const superDb = getSuperDb();
            const tenant = superDb.prepare(
                "SELECT * FROM salon_tenants WHERE email = ? AND status = 'active'"
            ).get(email);
            if (!tenant) return;

            const crypto = require('crypto');
            const rawToken = crypto.randomBytes(32).toString('hex');
            const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
            // Expires in 5 minutes
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
        const crypto = require('crypto');
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
```

- [ ] **Step 2: Update `GET /super-admin/api/reset-requests` to remove in-memory reference**

Find:
```javascript
app.get("/super-admin/api/reset-requests", requireSuperAdminAuth, (_req, res) => {
  res.json(Object.values(resetRequests));
});
```

Replace with:
```javascript
app.get("/super-admin/api/reset-requests", requireSuperAdminAuth, (_req, res) => {
  // Deprecated — reset requests are now handled via email tokens
  // Return empty array for backwards compatibility
  res.json([]);
});
```

- [ ] **Step 3: Test forgot password endpoint**

```bash
curl -s -X POST http://localhost:3000/tenant/forgot-password \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com"}'
```
Expected: `{"ok":true}` (always succeeds regardless of email existence)

- [ ] **Step 4: Commit**

```bash
git add src/index.js
git commit -m "feat: replace in-memory reset with DB-persisted token forgot/reset password"
```

---

## Task 8: Frontend — Install Stripe + Add Types

**Files:**
- `d:/vs self code/frontend/package.json`
- `d:/vs self code/frontend/lib/types.ts`

- [ ] **Step 1: No frontend Stripe SDK needed** — Registration uses Stripe Checkout redirect, so no `@stripe/stripe-js` install required. Just add `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` to Vercel env vars (no code dependency).

- [ ] **Step 2: Add new types to `lib/types.ts`**

Append to the end of `d:/vs self code/frontend/lib/types.ts`:

```typescript
export interface Plan {
  id: number;
  name: string;
  description: string | null;
  price_cents: number;
  billing_cycle: 'monthly' | 'yearly' | 'one-time';
  max_services: number;
  whatsapp_access: 0 | 1;
  instagram_access: 0 | 1;
  facebook_access: 0 | 1;
  ai_calls_access: 0 | 1;
  stripe_price_id: string | null;
  is_active: 0 | 1;
  created_at: string;
  updated_at: string;
}

export interface PublicPlan extends Omit<Plan, 'stripe_price_id' | 'is_active' | 'created_at' | 'updated_at'> {}

export interface Subscription {
  id: number;
  tenant_id: string;
  plan_id: number;
  stripe_subscription_id: string | null;
  stripe_customer_id: string | null;
  status: string;
  current_period_start: string | null;
  current_period_end: string | null;
  created_at: string;
  // Joined fields:
  salon_name: string;
  owner_name: string;
  email: string;
  plan_name: string;
  price_cents: number;
  billing_cycle: string;
}
```

- [ ] **Step 3: Add query functions to `lib/queries.ts`**

Append to end of `d:/vs self code/frontend/lib/queries.ts`:

```typescript
import type { Plan, Subscription } from './types';

export async function fetchPlans(): Promise<Plan[]> {
  const res = await fetch('/api/super-admin/plans', { credentials: 'include' });
  if (!res.ok) throw new Error('Failed to fetch plans');
  return res.json();
}

export async function fetchSubscriptions(): Promise<Subscription[]> {
  const res = await fetch('/api/super-admin/payments', { credentials: 'include' });
  if (!res.ok) throw new Error('Failed to fetch subscriptions');
  return res.json();
}

export async function fetchPublicPlans(): Promise<PublicPlan[]> {
  const res = await fetch('/api/public/plans');
  if (!res.ok) throw new Error('Failed to load plans');
  return res.json();
}
```

Note: `PublicPlan` import needs to be added to the import line.

- [ ] **Step 4: Commit**

```bash
cd "d:/vs self code/frontend"
git add lib/types.ts lib/queries.ts
git commit -m "feat: add Plan, Subscription, PublicPlan types and query functions"
```

---

## Task 9: Frontend — Next.js API Proxy Routes

**Files:**
- Create: `app/api/public/plans/route.ts`
- Create: `app/api/register/route.ts`
- Create: `app/api/super-admin/plans/route.ts`
- Create: `app/api/super-admin/plans/[id]/route.ts`
- Create: `app/api/super-admin/payments/route.ts`
- Create: `app/api/forgot-password/route.ts`
- Create: `app/api/reset-password/route.ts`

- [ ] **Step 1: Create `app/api/public/plans/route.ts`**

```typescript
import { NextResponse } from "next/server";

export async function GET() {
  const backend = process.env.BACKEND_URL || "http://localhost:3000";
  const res = await fetch(`${backend}/api/public/plans`);
  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}
```

- [ ] **Step 2: Create `app/api/register/route.ts`**

```typescript
import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const backend = process.env.BACKEND_URL || "http://localhost:3000";
  const body = await req.json();
  const upstream = await fetch(`${backend}/api/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await upstream.json();
  return NextResponse.json(data, { status: upstream.status });
}
```

- [ ] **Step 3: Create `app/api/super-admin/plans/route.ts`**

```typescript
import { NextRequest, NextResponse } from "next/server";

const BACKEND = () => process.env.BACKEND_URL || "http://localhost:3000";

async function forwardWithCookies(req: NextRequest, path: string, method: string, body?: unknown) {
  const cookie = req.headers.get("cookie") || "";
  const init: RequestInit = {
    method,
    headers: { "Content-Type": "application/json", Cookie: cookie },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const upstream = await fetch(`${BACKEND()}${path}`, init);
  const data = await upstream.json();
  return NextResponse.json(data, { status: upstream.status });
}

export async function GET(req: NextRequest) {
  return forwardWithCookies(req, "/super-admin/api/plans", "GET");
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  return forwardWithCookies(req, "/super-admin/api/plans", "POST", body);
}
```

- [ ] **Step 4: Create `app/api/super-admin/plans/[id]/route.ts`**

```typescript
import { NextRequest, NextResponse } from "next/server";

const BACKEND = () => process.env.BACKEND_URL || "http://localhost:3000";

async function forward(req: NextRequest, path: string, method: string, body?: unknown) {
  const cookie = req.headers.get("cookie") || "";
  const init: RequestInit = { method, headers: { "Content-Type": "application/json", Cookie: cookie } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const upstream = await fetch(`${BACKEND()}${path}`, init);
  const data = await upstream.json();
  return NextResponse.json(data, { status: upstream.status });
}

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json();
  return forward(req, `/super-admin/api/plans/${params.id}`, "PUT", body);
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  return forward(req, `/super-admin/api/plans/${params.id}`, "DELETE");
}
```

- [ ] **Step 5: Create `app/api/super-admin/payments/route.ts`**

```typescript
import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  const backend = process.env.BACKEND_URL || "http://localhost:3000";
  const cookie = req.headers.get("cookie") || "";
  const upstream = await fetch(`${backend}/super-admin/api/subscriptions`, {
    headers: { Cookie: cookie },
  });
  const data = await upstream.json();
  return NextResponse.json(data, { status: upstream.status });
}
```

- [ ] **Step 6: Create `app/api/forgot-password/route.ts`**

```typescript
import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const backend = process.env.BACKEND_URL || "http://localhost:3000";
  const body = await req.json();
  const upstream = await fetch(`${backend}/tenant/forgot-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await upstream.json();
  return NextResponse.json(data, { status: upstream.status });
}
```

- [ ] **Step 7: Create `app/api/reset-password/route.ts`**

```typescript
import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const backend = process.env.BACKEND_URL || "http://localhost:3000";
  const body = await req.json();
  const upstream = await fetch(`${backend}/tenant/reset-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await upstream.json();
  return NextResponse.json(data, { status: upstream.status });
}
```

- [ ] **Step 8: Commit**

```bash
cd "d:/vs self code/frontend"
git add app/api/public/ app/api/register/ app/api/super-admin/plans/ app/api/super-admin/payments/ app/api/forgot-password/ app/api/reset-password/
git commit -m "feat: add proxy API routes for plans, registration, payments, and password reset"
```

---

## Task 10: Frontend — Super Admin Plans Management Page

**Files:**
- Create: `app/(super)/super-admin/plans/page.tsx`

**Design spec:**
- Sidebar layout (reuse existing super admin layout)
- Plans listed as cards in a responsive grid (3 cols on desktop, 1 on mobile)
- Each card shows: name, price, billing cycle, feature toggle chips, active/inactive badge
- "New Plan" button opens a slide-in form panel (DrawerShell component)
- Feature flags as toggle switches with labels
- Delete = soft-deactivate with confirmation dialog

- [ ] **Step 1: Create `app/(super)/super-admin/plans/page.tsx`**

```tsx
"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchPlans } from "@/lib/queries";
import type { Plan } from "@/lib/types";
import { api } from "@/lib/api";
import { toast } from "sonner";
import { Badge } from "@/components/ui/Badge";
import { Skeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/EmptyState";
import { Plus, Pencil, Trash2, Check, X, MessageCircle, Instagram, Facebook, Phone } from "lucide-react";

type PlanFormData = {
  name: string;
  description: string;
  price_cents: number;
  billing_cycle: "monthly" | "yearly" | "one-time";
  max_services: number;
  whatsapp_access: boolean;
  instagram_access: boolean;
  facebook_access: boolean;
  ai_calls_access: boolean;
  stripe_price_id: string;
};

const BLANK: PlanFormData = {
  name: "",
  description: "",
  price_cents: 0,
  billing_cycle: "monthly",
  max_services: 10,
  whatsapp_access: false,
  instagram_access: false,
  facebook_access: false,
  ai_calls_access: false,
  stripe_price_id: "",
};

function FeatureChip({ label, active, icon }: { label: string; active: boolean; icon?: React.ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
        active
          ? "bg-violet-100 text-violet-700"
          : "bg-slate-100 text-slate-400 line-through"
      }`}
    >
      {icon}
      {label}
    </span>
  );
}

function PlanCard({
  plan,
  onEdit,
  onDelete,
}: {
  plan: Plan;
  onEdit: (p: Plan) => void;
  onDelete: (id: number) => void;
}) {
  const price = (plan.price_cents / 100).toFixed(2);
  const cycle = plan.billing_cycle === "monthly" ? "/mo" : plan.billing_cycle === "yearly" ? "/yr" : "";

  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5 flex flex-col gap-4">
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="font-semibold text-slate-900 text-base">{plan.name}</h3>
            <Badge variant={plan.is_active ? "success" : "default"}>
              {plan.is_active ? "Active" : "Inactive"}
            </Badge>
          </div>
          {plan.description && (
            <p className="text-sm text-slate-500 mt-0.5">{plan.description}</p>
          )}
        </div>
        <div className="flex gap-1.5 shrink-0">
          <button
            onClick={() => onEdit(plan)}
            className="p-1.5 rounded-lg text-slate-400 hover:text-violet-600 hover:bg-violet-50 transition-colors"
            aria-label="Edit plan"
          >
            <Pencil size={15} />
          </button>
          <button
            onClick={() => onDelete(plan.id)}
            className="p-1.5 rounded-lg text-slate-400 hover:text-red-500 hover:bg-red-50 transition-colors"
            aria-label="Deactivate plan"
          >
            <Trash2 size={15} />
          </button>
        </div>
      </div>

      <div className="text-2xl font-bold text-slate-900">
        ${price}
        <span className="text-sm font-normal text-slate-400 ml-1">{cycle}</span>
      </div>

      <div className="text-sm text-slate-600">
        <span className="font-medium">{plan.max_services}</span> max services
      </div>

      <div className="flex flex-wrap gap-1.5">
        <FeatureChip label="WhatsApp" active={!!plan.whatsapp_access} icon={<MessageCircle size={11} />} />
        <FeatureChip label="Instagram" active={!!plan.instagram_access} icon={<Instagram size={11} />} />
        <FeatureChip label="Facebook" active={!!plan.facebook_access} icon={<Facebook size={11} />} />
        <FeatureChip label="AI Calls" active={!!plan.ai_calls_access} icon={<Phone size={11} />} />
      </div>
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between py-2 cursor-pointer select-none">
      <span className="text-sm text-slate-700">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 ${
          checked ? "bg-violet-600" : "bg-slate-200"
        }`}
      >
        <span
          className={`inline-block h-4 w-4 mt-0.5 rounded-full bg-white shadow-sm transition-transform duration-150 ${
            checked ? "translate-x-4" : "translate-x-0.5"
          }`}
        />
      </button>
    </label>
  );
}

function PlanForm({
  initial,
  onClose,
  onSaved,
}: {
  initial: PlanFormData & { id?: number };
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<PlanFormData>({
    name: initial.name,
    description: initial.description,
    price_cents: initial.price_cents,
    billing_cycle: initial.billing_cycle,
    max_services: initial.max_services,
    whatsapp_access: !!initial.whatsapp_access,
    instagram_access: !!initial.instagram_access,
    facebook_access: !!initial.facebook_access,
    ai_calls_access: !!initial.ai_calls_access,
    stripe_price_id: initial.stripe_price_id,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const set = <K extends keyof PlanFormData>(key: K, value: PlanFormData[K]) =>
    setForm(f => ({ ...f, [key]: value }));

  async function handleSave() {
    if (!form.name.trim()) { setError("Plan name is required"); return; }
    if (form.price_cents < 0) { setError("Price cannot be negative"); return; }
    setError("");
    setSaving(true);
    try {
      const payload = {
        ...form,
        price_cents: Number(form.price_cents),
        max_services: Number(form.max_services),
        whatsapp_access: form.whatsapp_access ? 1 : 0,
        instagram_access: form.instagram_access ? 1 : 0,
        facebook_access: form.facebook_access ? 1 : 0,
        ai_calls_access: form.ai_calls_access ? 1 : 0,
      };
      if (initial.id) {
        await api.put(`/api/super-admin/plans/${initial.id}`, payload);
        toast.success("Plan updated");
      } else {
        await api.post("/api/super-admin/plans", payload);
        toast.success("Plan created");
      }
      onSaved();
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  const inputClass =
    "w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-violet-400 focus:ring-1 focus:ring-violet-400 transition-colors";

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between p-5 border-b border-slate-100">
        <h2 className="font-semibold text-slate-900">{initial.id ? "Edit Plan" : "New Plan"}</h2>
        <button
          onClick={onClose}
          className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors"
          aria-label="Close"
        >
          <X size={16} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-5 space-y-4">
        {error && (
          <div className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded-lg" role="alert">
            {error}
          </div>
        )}

        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">
            Plan Name <span className="text-red-500">*</span>
          </label>
          <input
            className={inputClass}
            value={form.name}
            onChange={e => set("name", e.target.value)}
            placeholder="e.g. Starter, Pro, Enterprise"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Description</label>
          <textarea
            className={inputClass + " resize-none"}
            rows={2}
            value={form.description}
            onChange={e => set("description", e.target.value)}
            placeholder="Short plan description"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              Price (cents) <span className="text-red-500">*</span>
            </label>
            <input
              type="number"
              min={0}
              className={inputClass}
              value={form.price_cents}
              onChange={e => set("price_cents", parseInt(e.target.value || "0", 10))}
              placeholder="e.g. 2900 = $29"
            />
            <p className="text-xs text-slate-400 mt-1">
              = ${(form.price_cents / 100).toFixed(2)}
            </p>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Billing Cycle</label>
            <select
              className={inputClass}
              value={form.billing_cycle}
              onChange={e => set("billing_cycle", e.target.value as PlanFormData["billing_cycle"])}
            >
              <option value="monthly">Monthly</option>
              <option value="yearly">Yearly</option>
              <option value="one-time">One-time</option>
            </select>
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Max Services</label>
          <input
            type="number"
            min={1}
            className={inputClass}
            value={form.max_services}
            onChange={e => set("max_services", parseInt(e.target.value || "1", 10))}
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">
            Stripe Price ID
          </label>
          <input
            className={inputClass}
            value={form.stripe_price_id}
            onChange={e => set("stripe_price_id", e.target.value)}
            placeholder="price_..."
          />
          <p className="text-xs text-slate-400 mt-1">
            Leave blank for free plans. Get this from your Stripe Dashboard.
          </p>
        </div>

        <div className="border border-slate-100 rounded-lg px-4 py-1 divide-y divide-slate-100">
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wide pt-3 pb-2">Features</p>
          <Toggle label="WhatsApp Chat" checked={form.whatsapp_access} onChange={v => set("whatsapp_access", v)} />
          <Toggle label="Instagram Chat" checked={form.instagram_access} onChange={v => set("instagram_access", v)} />
          <Toggle label="Facebook Chat" checked={form.facebook_access} onChange={v => set("facebook_access", v)} />
          <Toggle label="AI Voice Calls" checked={form.ai_calls_access} onChange={v => set("ai_calls_access", v)} />
        </div>
      </div>

      <div className="p-5 border-t border-slate-100 flex gap-2 justify-end">
        <button
          onClick={onClose}
          className="px-4 py-2 text-sm rounded-lg text-slate-600 hover:bg-slate-100 transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-4 py-2 text-sm rounded-lg bg-violet-600 text-white font-medium hover:bg-violet-700 disabled:opacity-50 transition-colors"
        >
          {saving ? "Saving…" : initial.id ? "Update Plan" : "Create Plan"}
        </button>
      </div>
    </div>
  );
}

export default function PlansPage() {
  const qc = useQueryClient();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState<(PlanFormData & { id?: number }) | null>(null);

  const { data: plans, isLoading } = useQuery<Plan[]>({
    queryKey: ["superPlans"],
    queryFn: fetchPlans,
    staleTime: 0,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.delete(`/api/super-admin/plans/${id}`),
    onSuccess: () => {
      toast.success("Plan deactivated");
      qc.invalidateQueries({ queryKey: ["superPlans"] });
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Delete failed"),
  });

  function handleEdit(plan: Plan) {
    setEditing({
      id: plan.id,
      name: plan.name,
      description: plan.description || "",
      price_cents: plan.price_cents,
      billing_cycle: plan.billing_cycle as PlanFormData["billing_cycle"],
      max_services: plan.max_services,
      whatsapp_access: !!plan.whatsapp_access,
      instagram_access: !!plan.instagram_access,
      facebook_access: !!plan.facebook_access,
      ai_calls_access: !!plan.ai_calls_access,
      stripe_price_id: plan.stripe_price_id || "",
    });
    setDrawerOpen(true);
  }

  function handleNew() {
    setEditing({ ...BLANK });
    setDrawerOpen(true);
  }

  function handleDelete(id: number) {
    if (!confirm("Deactivate this plan? Existing subscribers are unaffected.")) return;
    deleteMutation.mutate(id);
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Plans</h1>
          <p className="text-sm text-slate-500 mt-0.5">Manage subscription plans and feature access</p>
        </div>
        <button
          onClick={handleNew}
          className="inline-flex items-center gap-1.5 px-4 py-2 text-sm rounded-lg bg-violet-600 text-white font-medium hover:bg-violet-700 transition-colors"
        >
          <Plus size={15} />
          New Plan
        </button>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3].map(i => <Skeleton key={i} className="h-52 rounded-xl" />)}
        </div>
      ) : !plans?.length ? (
        <EmptyState
          title="No plans yet"
          description="Create your first subscription plan to allow salon admins to register."
          action={{ label: "Create Plan", onClick: handleNew }}
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {plans.map(p => (
            <PlanCard key={p.id} plan={p} onEdit={handleEdit} onDelete={handleDelete} />
          ))}
        </div>
      )}

      {/* Slide-in drawer */}
      {drawerOpen && editing && (
        <>
          <div
            className="fixed inset-0 bg-black/30 z-40"
            onClick={() => setDrawerOpen(false)}
          />
          <div className="fixed right-0 top-0 h-full w-full max-w-md bg-white shadow-xl z-50 flex flex-col">
            <PlanForm
              initial={editing}
              onClose={() => setDrawerOpen(false)}
              onSaved={() => qc.invalidateQueries({ queryKey: ["superPlans"] })}
            />
          </div>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add app/\(super\)/super-admin/plans/
git commit -m "feat: add super admin plans management page with create/edit/deactivate"
```

---

## Task 11: Frontend — Super Admin Payments Page

**Files:**
- Create: `app/(super)/super-admin/payments/page.tsx`
- Modify: `app/(super)/super-admin/dashboard/page.tsx` (add sidebar links)

- [ ] **Step 1: Create `app/(super)/super-admin/payments/page.tsx`**

```tsx
"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchSubscriptions } from "@/lib/queries";
import type { Subscription } from "@/lib/types";
import { Badge } from "@/components/ui/Badge";
import { Skeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/EmptyState";

function formatCents(cents: number, cycle: string) {
  const price = `$${(cents / 100).toFixed(2)}`;
  if (cycle === "monthly") return `${price}/mo`;
  if (cycle === "yearly") return `${price}/yr`;
  return price;
}

function statusVariant(status: string): "success" | "warning" | "destructive" | "default" {
  if (status === "active") return "success";
  if (status === "past_due") return "warning";
  if (status === "canceled") return "destructive";
  return "default";
}

export default function PaymentsPage() {
  const { data: subs, isLoading } = useQuery<Subscription[]>({
    queryKey: ["superSubscriptions"],
    queryFn: fetchSubscriptions,
    staleTime: 30_000,
  });

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-slate-900">Payments & Subscriptions</h1>
        <p className="text-sm text-slate-500 mt-0.5">All salon admin subscriptions</p>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map(i => <Skeleton key={i} className="h-14 rounded-xl" />)}
        </div>
      ) : !subs?.length ? (
        <EmptyState
          title="No subscriptions yet"
          description="Subscriptions appear here after salon admins complete registration."
        />
      ) : (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden shadow-sm">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50">
                <th className="text-left px-4 py-3 font-medium text-slate-600">Salon</th>
                <th className="text-left px-4 py-3 font-medium text-slate-600">Owner</th>
                <th className="text-left px-4 py-3 font-medium text-slate-600">Email</th>
                <th className="text-left px-4 py-3 font-medium text-slate-600">Plan</th>
                <th className="text-left px-4 py-3 font-medium text-slate-600">Price</th>
                <th className="text-left px-4 py-3 font-medium text-slate-600">Status</th>
                <th className="text-left px-4 py-3 font-medium text-slate-600">Since</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {subs.map(s => (
                <tr key={s.id} className="hover:bg-slate-50/50 transition-colors">
                  <td className="px-4 py-3 font-medium text-slate-900">{s.salon_name}</td>
                  <td className="px-4 py-3 text-slate-600">{s.owner_name}</td>
                  <td className="px-4 py-3 text-slate-500">{s.email}</td>
                  <td className="px-4 py-3 text-slate-700">{s.plan_name}</td>
                  <td className="px-4 py-3 text-slate-700 tabular-nums">
                    {formatCents(s.price_cents, s.billing_cycle)}
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant={statusVariant(s.status)}>{s.status}</Badge>
                  </td>
                  <td className="px-4 py-3 text-slate-400 tabular-nums">
                    {new Date(s.created_at).toLocaleDateString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Add Plans and Payments sidebar links to super admin dashboard**

In `app/(super)/super-admin/dashboard/page.tsx`, find the sidebar navigation section. Look for existing nav links (Dashboard, Salon Admins) and add:

```tsx
<a
  href="/super-admin/plans"
  className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-slate-600 hover:bg-slate-100 hover:text-slate-900 transition-colors"
>
  {/* Use inline SVG or import from lucide */}
  Plans
</a>
<a
  href="/super-admin/payments"
  className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-slate-600 hover:bg-slate-100 hover:text-slate-900 transition-colors"
>
  Payments
</a>
```

Note: Read the actual sidebar implementation in dashboard/page.tsx before editing — match the exact link component/style pattern already used.

- [ ] **Step 3: Commit**

```bash
git add app/\(super\)/super-admin/payments/ app/\(super\)/super-admin/dashboard/page.tsx
git commit -m "feat: add payments page and plans/payments sidebar links"
```

---

## Task 12: Frontend — Public Registration Page

**Files:**
- Create: `app/(public)/layout.tsx`
- Create: `app/(public)/register/page.tsx`
- Create: `app/(public)/register/success/page.tsx`

- [ ] **Step 1: Create `app/(public)/layout.tsx`**

```tsx
export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ minHeight: "100vh", background: "#f8fafc" }}>
      {children}
    </div>
  );
}
```

- [ ] **Step 2: Create `app/(public)/register/page.tsx`**

```tsx
"use client";

import { useEffect, useState } from "react";
import type { PublicPlan } from "@/lib/types";
import { Check, MessageCircle, Instagram, Facebook, Phone } from "lucide-react";

function PlanCard({ plan, selected, onSelect }: { plan: PublicPlan; selected: boolean; onSelect: () => void }) {
  const price = (plan.price_cents / 100).toFixed(2);
  const isFree = plan.price_cents === 0;
  const cycleLabel = plan.billing_cycle === "monthly" ? "/month" : plan.billing_cycle === "yearly" ? "/year" : "";

  const features = [
    { label: "WhatsApp Chat", active: !!plan.whatsapp_access, icon: <MessageCircle size={14} /> },
    { label: "Instagram Chat", active: !!plan.instagram_access, icon: <Instagram size={14} /> },
    { label: "Facebook Chat", active: !!plan.facebook_access, icon: <Facebook size={14} /> },
    { label: "AI Voice Calls", active: !!plan.ai_calls_access, icon: <Phone size={14} /> },
    { label: `Up to ${plan.max_services} services`, active: true, icon: <Check size={14} /> },
  ];

  return (
    <div
      onClick={onSelect}
      className={`relative cursor-pointer rounded-xl border-2 p-5 transition-all ${
        selected
          ? "border-violet-500 bg-violet-50 shadow-md"
          : "border-slate-200 bg-white hover:border-violet-300 hover:shadow-sm"
      }`}
    >
      {selected && (
        <div className="absolute top-3 right-3 w-5 h-5 rounded-full bg-violet-600 flex items-center justify-center">
          <Check size={11} color="white" strokeWidth={3} />
        </div>
      )}
      <h3 className="font-semibold text-slate-900 text-base">{plan.name}</h3>
      {plan.description && <p className="text-sm text-slate-500 mt-0.5">{plan.description}</p>}
      <div className="mt-3 text-2xl font-bold text-slate-900">
        {isFree ? "Free" : `$${price}`}
        {!isFree && <span className="text-sm font-normal text-slate-400 ml-1">{cycleLabel}</span>}
      </div>
      <ul className="mt-4 space-y-1.5">
        {features.map(f => (
          <li key={f.label} className={`flex items-center gap-2 text-sm ${f.active ? "text-slate-700" : "text-slate-300 line-through"}`}>
            <span className={f.active ? "text-violet-500" : "text-slate-300"}>{f.icon}</span>
            {f.label}
          </li>
        ))}
      </ul>
    </div>
  );
}

type Step = "plan" | "details" | "processing";

export default function RegisterPage() {
  const [plans, setPlans] = useState<PublicPlan[]>([]);
  const [plansLoading, setPlansLoading] = useState(true);
  const [selectedPlan, setSelectedPlan] = useState<PublicPlan | null>(null);
  const [step, setStep] = useState<Step>("plan");
  const [form, setForm] = useState({ owner_name: "", salon_name: "", email: "", phone: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");

  useEffect(() => {
    fetch("/api/public/plans")
      .then(r => r.json())
      .then((data: PublicPlan[]) => { setPlans(data); setPlansLoading(false); })
      .catch(() => setPlansLoading(false));
  }, []);

  function validateDetails() {
    const e: Record<string, string> = {};
    if (!form.owner_name.trim()) e.owner_name = "Owner name is required";
    if (!form.salon_name.trim()) e.salon_name = "Salon name is required";
    if (!form.email.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email))
      e.email = "Valid email is required";
    if (!form.phone.trim()) e.phone = "Phone is required";
    return e;
  }

  async function handleSubmit() {
    const errs = validateDetails();
    if (Object.keys(errs).length) { setErrors(errs); return; }
    setErrors({});
    setSubmitting(true);
    setSubmitError("");

    try {
      const res = await fetch("/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, plan_id: selectedPlan!.id }),
      });
      const data = await res.json();
      if (!res.ok) { setSubmitError(data.error || "Registration failed"); setSubmitting(false); return; }

      if (data.checkout_url) {
        // Paid plan — redirect to Stripe Checkout
        window.location.href = data.checkout_url;
      } else if (data.redirect) {
        // Free plan — go to login
        window.location.href = data.redirect;
      }
    } catch {
      setSubmitError("Network error. Please try again.");
      setSubmitting(false);
    }
  }

  const inputClass =
    "w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-violet-400 focus:ring-1 focus:ring-violet-400 transition-colors";

  return (
    <div className="min-h-screen bg-gradient-to-br from-violet-50 to-indigo-50 flex flex-col items-center py-12 px-4">
      {/* Header */}
      <div className="text-center mb-8">
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 52,
            height: 52,
            borderRadius: 14,
            background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
            marginBottom: 12,
          }}
        >
          <span style={{ fontSize: 24 }}>💅</span>
        </div>
        <h1 className="text-2xl font-bold text-slate-900">Create your SalonBot account</h1>
        <p className="text-slate-500 mt-1.5 text-sm">Choose a plan and get started in minutes</p>
      </div>

      {/* Step indicators */}
      <div className="flex items-center gap-2 mb-8">
        {(["plan", "details"] as Step[]).map((s, i) => (
          <div key={s} className="flex items-center gap-2">
            {i > 0 && <div className="w-8 h-px bg-slate-200" />}
            <div
              className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold transition-colors ${
                step === s
                  ? "bg-violet-600 text-white"
                  : step === "details" && s === "plan"
                  ? "bg-violet-100 text-violet-600"
                  : "bg-slate-100 text-slate-400"
              }`}
            >
              {step === "details" && s === "plan" ? <Check size={12} /> : i + 1}
            </div>
            <span className={`text-xs ${step === s ? "text-slate-900 font-medium" : "text-slate-400"}`}>
              {s === "plan" ? "Choose plan" : "Your details"}
            </span>
          </div>
        ))}
      </div>

      <div className="w-full max-w-3xl">
        {/* Step 1: Plan selection */}
        {step === "plan" && (
          <>
            {plansLoading ? (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {[1, 2, 3].map(i => (
                  <div key={i} className="h-64 rounded-xl bg-white/60 animate-pulse" />
                ))}
              </div>
            ) : !plans.length ? (
              <div className="text-center text-slate-500 py-12">No plans available at this time.</div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {plans.map(p => (
                  <PlanCard
                    key={p.id}
                    plan={p}
                    selected={selectedPlan?.id === p.id}
                    onSelect={() => setSelectedPlan(p)}
                  />
                ))}
              </div>
            )}

            <div className="mt-6 flex justify-end">
              <button
                disabled={!selectedPlan}
                onClick={() => setStep("details")}
                className="px-6 py-2.5 text-sm rounded-lg bg-violet-600 text-white font-medium hover:bg-violet-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Continue
              </button>
            </div>
          </>
        )}

        {/* Step 2: Details */}
        {step === "details" && (
          <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6 max-w-md mx-auto">
            <h2 className="font-semibold text-slate-900 mb-1">Your details</h2>
            <p className="text-sm text-slate-500 mb-5">
              Selected: <strong>{selectedPlan?.name}</strong>
              {" · "}
              <button
                onClick={() => setStep("plan")}
                className="text-violet-600 hover:underline text-sm"
              >
                Change
              </button>
            </p>

            {submitError && (
              <div className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded-lg mb-4" role="alert">
                {submitError}
              </div>
            )}

            <div className="space-y-4">
              {([
                { key: "owner_name", label: "Your Name", placeholder: "Jane Smith" },
                { key: "salon_name", label: "Salon Name", placeholder: "Luxe Hair Studio" },
                { key: "email", label: "Email Address", placeholder: "jane@example.com", type: "email" },
                { key: "phone", label: "Phone Number", placeholder: "+1 555 000 0000", type: "tel" },
              ] as const).map(f => (
                <div key={f.key}>
                  <label className="block text-sm font-medium text-slate-700 mb-1">
                    {f.label} <span className="text-red-500">*</span>
                  </label>
                  <input
                    type={f.type || "text"}
                    className={`${inputClass} ${errors[f.key] ? "border-red-400 focus:border-red-400 focus:ring-red-400" : ""}`}
                    placeholder={f.placeholder}
                    value={form[f.key]}
                    onChange={e => setForm(prev => ({ ...prev, [f.key]: e.target.value }))}
                  />
                  {errors[f.key] && (
                    <p className="text-xs text-red-500 mt-1" role="alert">{errors[f.key]}</p>
                  )}
                </div>
              ))}
            </div>

            <div className="mt-6 flex gap-3">
              <button
                onClick={() => setStep("plan")}
                className="px-4 py-2.5 text-sm rounded-lg text-slate-600 hover:bg-slate-100 transition-colors"
              >
                Back
              </button>
              <button
                onClick={handleSubmit}
                disabled={submitting}
                className="flex-1 py-2.5 text-sm rounded-lg bg-violet-600 text-white font-medium hover:bg-violet-700 disabled:opacity-50 transition-colors"
              >
                {submitting
                  ? "Redirecting to payment…"
                  : selectedPlan?.price_cents === 0
                  ? "Create Free Account"
                  : `Pay $${((selectedPlan?.price_cents || 0) / 100).toFixed(2)} & Register`}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Create `app/(public)/register/success/page.tsx`**

```tsx
"use client";

import { useSearchParams } from "next/navigation";
import { CheckCircle } from "lucide-react";
import { Suspense } from "react";

function SuccessContent() {
  const params = useSearchParams();
  const sessionId = params.get("session_id");

  return (
    <div className="min-h-screen bg-gradient-to-br from-violet-50 to-indigo-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-10 max-w-md w-full text-center">
        <div className="flex justify-center mb-4">
          <div className="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center">
            <CheckCircle size={32} className="text-green-600" />
          </div>
        </div>
        <h1 className="text-xl font-bold text-slate-900 mb-2">Payment successful!</h1>
        <p className="text-slate-500 text-sm mb-6">
          Your account is being set up. You'll receive a welcome email with your login credentials shortly.
        </p>
        <a
          href="/login"
          className="inline-block px-6 py-2.5 text-sm rounded-lg bg-violet-600 text-white font-medium hover:bg-violet-700 transition-colors"
        >
          Go to Login
        </a>
      </div>
    </div>
  );
}

export default function RegisterSuccessPage() {
  return (
    <Suspense>
      <SuccessContent />
    </Suspense>
  );
}
```

- [ ] **Step 4: Commit**

```bash
git add app/\(public\)/
git commit -m "feat: add public registration page with plan selection and Stripe redirect"
```

---

## Task 13: Frontend — Forgot Password Page

**Files:**
- Create: `app/(auth)/forgot-password/page.tsx`

- [ ] **Step 1: Create `app/(auth)/forgot-password/page.tsx`**

```tsx
"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, Mail } from "lucide-react";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) { setError("Email is required"); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setError("Enter a valid email"); return; }
    setError("");
    setLoading(true);
    try {
      await fetch("/api/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      // Always show success — don't leak whether email exists
      setSubmitted(true);
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
        padding: "20px",
      }}
    >
      <div
        style={{
          background: "#fff",
          borderRadius: "16px",
          boxShadow: "0 20px 60px rgba(0,0,0,0.2)",
          width: "100%",
          maxWidth: "420px",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
            color: "#fff",
            padding: "32px 40px 24px",
            textAlign: "center",
          }}
        >
          <div style={{ fontSize: 36, marginBottom: 8 }}>🔑</div>
          <h1 style={{ fontSize: "20px", fontWeight: 700, margin: 0 }}>Forgot Password</h1>
          <p style={{ opacity: 0.85, fontSize: "13px", marginTop: "4px" }}>
            We'll send a reset link to your email
          </p>
        </div>

        <div style={{ padding: "32px 40px" }}>
          {submitted ? (
            <div style={{ textAlign: "center" }}>
              <div
                style={{
                  width: 56,
                  height: 56,
                  borderRadius: "50%",
                  background: "#f0fdf4",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  margin: "0 auto 16px",
                }}
              >
                <Mail size={24} color="#16a34a" />
              </div>
              <p style={{ color: "#374151", fontSize: 15, margin: "0 0 8px", fontWeight: 600 }}>
                Check your inbox
              </p>
              <p style={{ color: "#6b7280", fontSize: 13, margin: "0 0 24px" }}>
                If an account exists for <strong>{email}</strong>, you'll receive a reset link shortly.
                The link expires in <strong>5 minutes</strong>.
              </p>
              <Link
                href="/login"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  color: "#7c3aed",
                  fontSize: 13,
                  textDecoration: "none",
                  fontWeight: 500,
                }}
              >
                <ArrowLeft size={14} />
                Back to login
              </Link>
            </div>
          ) : (
            <form onSubmit={handleSubmit}>
              {error && (
                <div
                  style={{
                    background: "#fee2e2",
                    color: "#dc2626",
                    padding: "10px 14px",
                    borderRadius: "8px",
                    fontSize: "13px",
                    marginBottom: "20px",
                  }}
                  role="alert"
                >
                  {error}
                </div>
              )}
              <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: "#374151", marginBottom: 6 }}>
                Email Address <span style={{ color: "#ef4444" }}>*</span>
              </label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="your@email.com"
                autoFocus
                style={{
                  width: "100%",
                  padding: "11px 14px",
                  border: "2px solid #e2e8f0",
                  borderRadius: "8px",
                  fontSize: "14px",
                  marginBottom: "20px",
                  outline: "none",
                  boxSizing: "border-box",
                  transition: "border-color 0.15s",
                }}
                onFocus={e => { e.target.style.borderColor = "#7c3aed"; }}
                onBlur={e => { e.target.style.borderColor = "#e2e8f0"; }}
              />
              <button
                type="submit"
                disabled={loading}
                style={{
                  width: "100%",
                  padding: "12px",
                  background: loading ? "#a78bfa" : "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
                  color: "#fff",
                  border: "none",
                  borderRadius: "8px",
                  fontSize: "14px",
                  fontWeight: 600,
                  cursor: loading ? "not-allowed" : "pointer",
                  transition: "opacity 0.15s",
                }}
              >
                {loading ? "Sending…" : "Send Reset Link"}
              </button>
              <div style={{ marginTop: 20, textAlign: "center" }}>
                <Link
                  href="/login"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 5,
                    color: "#7c3aed",
                    fontSize: 13,
                    textDecoration: "none",
                    fontWeight: 500,
                  }}
                >
                  <ArrowLeft size={13} />
                  Back to login
                </Link>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add "Forgot password?" link to existing salon admin login page**

Read `app/(auth)/login/page.tsx` and add a link below the login button:

```tsx
<div style={{ textAlign: "center", marginTop: 14 }}>
  <a
    href="/forgot-password"
    style={{ color: "#7c3aed", fontSize: 13, textDecoration: "none" }}
  >
    Forgot password?
  </a>
</div>
```

- [ ] **Step 3: Commit**

```bash
git add app/\(auth\)/forgot-password/ app/\(auth\)/login/page.tsx
git commit -m "feat: add forgot password page and link from login"
```

---

## Task 14: Frontend — Reset Password Page

**Files:**
- Create: `app/(auth)/reset-password/page.tsx`

- [ ] **Step 1: Create `app/(auth)/reset-password/page.tsx`**

```tsx
"use client";

import { useState, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Eye, EyeOff, CheckCircle } from "lucide-react";

function ResetPasswordContent() {
  const params = useSearchParams();
  const router = useRouter();
  const token = params.get("token") || "";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPwd, setShowPwd] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

  if (!token) {
    return (
      <div style={{ textAlign: "center", padding: "32px 40px" }}>
        <p style={{ color: "#dc2626", fontSize: 14 }}>Invalid or missing reset token.</p>
        <Link href="/forgot-password" style={{ color: "#7c3aed", fontSize: 13, display: "block", marginTop: 12 }}>
          Request a new reset link
        </Link>
      </div>
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 8) { setError("Password must be at least 8 characters"); return; }
    if (password !== confirm) { setError("Passwords do not match"); return; }
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, new_password: password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Reset failed. The link may have expired.");
      } else {
        setSuccess(true);
        setTimeout(() => router.push("/login"), 3000);
      }
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  const inputStyle: React.CSSProperties = {
    width: "100%",
    padding: "11px 14px",
    border: "2px solid #e2e8f0",
    borderRadius: "8px",
    fontSize: "14px",
    outline: "none",
    boxSizing: "border-box",
    transition: "border-color 0.15s",
  };

  return (
    <div style={{ padding: "32px 40px" }}>
      {success ? (
        <div style={{ textAlign: "center" }}>
          <div style={{ display: "flex", justifyContent: "center", marginBottom: 12 }}>
            <CheckCircle size={48} color="#16a34a" />
          </div>
          <p style={{ color: "#374151", fontWeight: 600, fontSize: 15, margin: "0 0 8px" }}>
            Password reset!
          </p>
          <p style={{ color: "#6b7280", fontSize: 13, margin: "0 0 16px" }}>
            Redirecting to login…
          </p>
          <Link href="/login" style={{ color: "#7c3aed", fontSize: 13 }}>
            Go to login now
          </Link>
        </div>
      ) : (
        <form onSubmit={handleSubmit}>
          {error && (
            <div
              style={{
                background: "#fee2e2", color: "#dc2626",
                padding: "10px 14px", borderRadius: "8px",
                fontSize: "13px", marginBottom: "20px",
              }}
              role="alert"
            >
              {error}
            </div>
          )}

          <div style={{ marginBottom: 16 }}>
            <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: "#374151", marginBottom: 6 }}>
              New Password <span style={{ color: "#ef4444" }}>*</span>
            </label>
            <div style={{ position: "relative" }}>
              <input
                type={showPwd ? "text" : "password"}
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="At least 8 characters"
                autoFocus
                style={{ ...inputStyle, paddingRight: 40 }}
                onFocus={e => { e.target.style.borderColor = "#7c3aed"; }}
                onBlur={e => { e.target.style.borderColor = "#e2e8f0"; }}
              />
              <button
                type="button"
                onClick={() => setShowPwd(v => !v)}
                style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", color: "#94a3b8", padding: 0 }}
                aria-label={showPwd ? "Hide password" : "Show password"}
              >
                {showPwd ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>

          <div style={{ marginBottom: 24 }}>
            <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: "#374151", marginBottom: 6 }}>
              Confirm Password <span style={{ color: "#ef4444" }}>*</span>
            </label>
            <div style={{ position: "relative" }}>
              <input
                type={showConfirm ? "text" : "password"}
                value={confirm}
                onChange={e => setConfirm(e.target.value)}
                placeholder="Repeat your password"
                style={{ ...inputStyle, paddingRight: 40 }}
                onFocus={e => { e.target.style.borderColor = "#7c3aed"; }}
                onBlur={e => { e.target.style.borderColor = "#e2e8f0"; }}
              />
              <button
                type="button"
                onClick={() => setShowConfirm(v => !v)}
                style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", color: "#94a3b8", padding: 0 }}
                aria-label={showConfirm ? "Hide password" : "Show password"}
              >
                {showConfirm ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
            {confirm && password !== confirm && (
              <p style={{ color: "#dc2626", fontSize: 12, marginTop: 4 }} role="alert">
                Passwords do not match
              </p>
            )}
          </div>

          <button
            type="submit"
            disabled={loading}
            style={{
              width: "100%", padding: "12px",
              background: loading ? "#a78bfa" : "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
              color: "#fff", border: "none", borderRadius: "8px",
              fontSize: "14px", fontWeight: 600,
              cursor: loading ? "not-allowed" : "pointer",
            }}
          >
            {loading ? "Resetting…" : "Reset Password"}
          </button>
        </form>
      )}
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
        padding: "20px",
      }}
    >
      <div
        style={{
          background: "#fff",
          borderRadius: "16px",
          boxShadow: "0 20px 60px rgba(0,0,0,0.2)",
          width: "100%",
          maxWidth: "420px",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
            color: "#fff",
            padding: "32px 40px 24px",
            textAlign: "center",
          }}
        >
          <div style={{ fontSize: 36, marginBottom: 8 }}>🔒</div>
          <h1 style={{ fontSize: "20px", fontWeight: 700, margin: 0 }}>Set New Password</h1>
          <p style={{ opacity: 0.85, fontSize: "13px", marginTop: "4px" }}>
            Choose a strong password for your account
          </p>
        </div>
        <Suspense fallback={<div style={{ padding: 40, textAlign: "center", color: "#94a3b8" }}>Loading…</div>}>
          <ResetPasswordContent />
        </Suspense>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add app/\(auth\)/reset-password/
git commit -m "feat: add reset password page with token validation and show/hide toggle"
```

---

## Post-Implementation Self-Review

### Spec Coverage Check

| Requirement | Task | Status |
|-------------|------|--------|
| Super Admin sidebar with Dashboard, Plans, Salon Admins, Payments | Task 11 (sidebar links) + Task 10 + Task 11 pages | ✅ |
| Create/edit plans with price, billing cycle, feature flags | Task 1 (DB) + Task 5 (API) + Task 10 (UI) | ✅ |
| Max services per plan | Task 1 (DB field) + Task 5 (API) + Task 10 (UI) | ✅ |
| WhatsApp/Instagram/Facebook/AI calls feature flags | Task 1 (DB fields) + Task 5 (API) + Task 10 (UI toggles) | ✅ |
| Public registration page | Task 12 | ✅ |
| Plan selection on registration | Task 12 (PlanCard + step flow) | ✅ |
| Stripe subscription payment | Task 4 (service) + Task 6 (routes) + Task 12 (redirect) | ✅ |
| Create tenant on successful payment | Task 6 (webhook) | ✅ |
| Welcome email with login/password/portal URL | Task 3 (emailService) + Task 6 (webhook calls it) | ✅ |
| Forgot password request | Task 7 (backend) + Task 13 (frontend) | ✅ |
| Reset email with secure link | Task 7 (emailService.sendPasswordResetEmail) | ✅ |
| Reset link expires in 5 minutes | Task 7 (5 * 60 * 1000 ms expiry) | ✅ |
| Reset page with new + confirm password | Task 14 | ✅ |
| Redirect to login after reset | Task 14 (setTimeout + router.push) | ✅ |
| DB schema for plans, users, subscriptions | Task 1 | ✅ |
| API endpoints | Tasks 5, 6, 7, 9 | ✅ |
| Auth/authorization logic | requireSuperAdminAuth (existing) + Task 9 (proxy forwards cookies) | ✅ |
| Stripe integration flow | Tasks 4, 6 | ✅ |
| Email and token expiration logic | Tasks 3, 7 | ✅ |

### Placeholder Scan

No TBDs, TODOs, or "implement later" in any task. All code blocks are complete.

### Type Consistency Check

- `Plan.id` (number) → used as `plan.id` in all tasks ✅
- `plan_id` passed as metadata to Stripe → parsed back as `parseInt(plan_id, 10)` in webhook ✅  
- `price_cents` stored as INTEGER, converted to `price_cents / 100` for display ✅
- `PlanFormData` types match what the API expects ✅
- `fetchPublicPlans` returns `PublicPlan[]` used in register page as `PublicPlan[]` ✅

---

## Environment Setup Checklist

Before deploying, configure these:

**Railway (backend):**
```
STRIPE_SECRET_KEY=sk_...
STRIPE_WEBHOOK_SECRET=whsec_...   # from Stripe Dashboard → Webhooks
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
SMTP_FROM="SalonBot <noreply@yourdomain.com>"
FRONTEND_URL=https://your-app.vercel.app
```

**Stripe Dashboard setup:**
1. Create Products + Prices matching each plan
2. Copy `price_...` IDs into each plan's `stripe_price_id` field via the Plans management page
3. Add webhook endpoint: `https://your-railway-app.railway.app/api/stripe/webhook`
4. Events to listen: `checkout.session.completed`
5. Copy webhook signing secret → `STRIPE_WEBHOOK_SECRET`

**Vercel (frontend):** No new env vars required. `BACKEND_URL` already set.
