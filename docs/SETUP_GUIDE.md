# SalonBot — Setup Guide

All links, env vars, and service notes in one place.

---

## All URLs

### Public (no login required)

| Page | Local | Production |
|------|-------|------------|
| **Plan selection** (salon admin registers here) | `http://localhost:3001/register` | `https://your-vercel.app/register` |
| Registration success | `http://localhost:3001/register/success` | `https://your-vercel.app/register/success` |

### Salon Admin

| Page | Local | Production |
|------|-------|------------|
| Login | `http://localhost:3001/login` | `https://your-vercel.app/login` |
| Dashboard | `http://localhost:3001/dashboard` | `https://your-vercel.app/dashboard` |
| Bookings | `http://localhost:3001/bookings` | `https://your-vercel.app/bookings` |
| Settings | `http://localhost:3001/settings` | `https://your-vercel.app/settings` |

### Super Admin

| Page | Local | Production |
|------|-------|------------|
| Login | `http://localhost:3001/super-admin/login` | `https://your-vercel.app/super-admin/login` |
| Dashboard | `http://localhost:3001/super-admin/dashboard` | `https://your-vercel.app/super-admin/dashboard` |
| **Plans** (add stripe_price_id here) | `http://localhost:3001/super-admin/plans` | `https://your-vercel.app/super-admin/plans` |
| Payments / Subscriptions | `http://localhost:3001/super-admin/payments` | `https://your-vercel.app/super-admin/payments` |

> Frontend runs on `:3001`. Backend (Express) runs on `:3000`. Next.js proxies all `/salon-admin/*`, `/super-admin/*`, `/widget/*` to backend automatically.

---

## Registration Flow (how a salon signs up)

```
/register
  → Step 1: Pick a plan   (fetches GET /api/public/plans → backend)
  → Step 2: Fill details  (owner name, salon name, email, phone)
  → POST /api/register

  Free plan  → tenant created immediately → welcome email sent → redirect /login
  Paid plan  → Stripe Checkout session created → user pays on Stripe
            → Stripe redirects to /register/success?session_id=...
            → Stripe fires webhook POST /api/stripe/webhook
            → webhook creates tenant + sends welcome email → /login
```

---

## Stripe Keys — Where to Add

### Backend `.env` (Railway env vars in production)

```env
STRIPE_SECRET_KEY=sk_test_...          # Stripe Dashboard → Developers → API Keys
STRIPE_WEBHOOK_SECRET=whsec_...        # Stripe Dashboard → Webhooks → signing secret
```

### Per-plan Stripe Price ID

Each plan needs a `stripe_price_id` to accept payments.

1. Go to **Stripe Dashboard → Products** → create a product + recurring price
2. Copy the **Price ID** (starts with `price_...`)
3. Go to **Super Admin → Plans** (`/super-admin/plans`)
4. Edit the plan → paste the Price ID into the `Stripe Price ID` field

Plans without a `stripe_price_id` return an error when someone tries to pay:
> "This plan is not yet available for purchase."

Free plans (`price_cents = 0`) bypass Stripe entirely.

### Stripe Webhook Setup (production)

1. Stripe Dashboard → Developers → Webhooks → Add endpoint
2. URL: `https://your-railway-backend.app/api/stripe/webhook`
3. Event to listen: `checkout.session.completed`
4. Copy the **Signing secret** → set as `STRIPE_WEBHOOK_SECRET`

### Local Webhook Testing (Stripe CLI)

```bash
stripe listen --forward-to localhost:3000/api/stripe/webhook
# Copy the whsec_... it prints → set as STRIPE_WEBHOOK_SECRET in .env
```

---

## Email Service — Does It Work on Localhost?

**Yes.** Nodemailer connects directly to the SMTP server — it doesn't care whether your app is on HTTP localhost or HTTPS production. As long as SMTP credentials are valid, emails send.

### Required env vars (backend `.env`)

```env
SMTP_HOST=smtp.mailtrap.io          # or smtp.gmail.com
SMTP_PORT=587                        # 465 for SSL, 587 for TLS
SMTP_USER=your_smtp_username
SMTP_PASS=your_smtp_password
SMTP_FROM="SalonBot" <noreply@salonbot.com>   # optional, this is the default
FRONTEND_URL=http://localhost:3001   # used in email login links — MUST match your frontend port
```

### Recommended SMTP for local dev: Mailtrap

Mailtrap catches all emails in a fake inbox — nothing reaches real inboxes.

1. Sign up at mailtrap.io → Inboxes → SMTP Settings
2. Copy host/port/user/pass → paste into `.env`
3. Send a test registration → check Mailtrap inbox

### Gmail SMTP (quick alternative)

```env
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your@gmail.com
SMTP_PASS=your_app_password    # Gmail → Security → App Passwords (2FA must be on)
```

---

## Complete `.env` for Local Dev

```env
# Server
PORT=3000
NODE_ENV=development

# Auth
TENANT_JWT_SECRET=generate_with_openssl_rand_hex_32
SUPER_ADMIN_USERNAME=admin
SUPER_ADMIN_PASSWORD=your_password_here

# Database
SUPER_DB_PATH=./super.db

# Frontend URL (used in email links + Stripe redirect URLs)
FRONTEND_URL=http://localhost:3001

# Stripe
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...     # from: stripe listen --forward-to localhost:3000/api/stripe/webhook

# Email
SMTP_HOST=smtp.mailtrap.io
SMTP_PORT=587
SMTP_USER=your_mailtrap_user
SMTP_PASS=your_mailtrap_pass

# Gemini (AI chatbot + voice)
GEMINI_API_KEY=your_gemini_key_here

# Meta webhooks (per-tenant, set via Super Admin UI — these are legacy fallbacks)
META_VERIFY_TOKEN=any_random_string
```

---

## Common Issues

| Problem | Cause | Fix |
|---------|-------|-----|
| Paid plan says "not available for purchase" | `stripe_price_id` not set on plan | Super Admin → Plans → edit plan → add Stripe Price ID |
| Welcome email not received | SMTP creds missing or wrong | Check `SMTP_HOST/USER/PASS` in `.env` |
| Stripe webhook creates no tenant | `STRIPE_WEBHOOK_SECRET` wrong | Re-copy from Stripe CLI or Dashboard |
| Email login link points to wrong port | `FRONTEND_URL` wrong | Set `FRONTEND_URL=http://localhost:3001` |
| Free plan redirects to `:3002` | Default fallback in code is `3002` | Always set `FRONTEND_URL` explicitly |
