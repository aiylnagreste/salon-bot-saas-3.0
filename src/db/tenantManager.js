const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const path = require('path');
const logger = require('../utils/logger');

const SUPER_DB_PATH = process.env.SUPER_DB_PATH || path.join(__dirname, '../../super.db');
let superDb = null;

// Table templates for tenant creation
const TENANT_TABLE_TEMPLATES = {
    bookings: `
        CREATE TABLE IF NOT EXISTS {{TENANT}}_bookings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            customer_name TEXT NOT NULL,
            phone TEXT,
            service TEXT,
            branch TEXT,
            date TEXT,
            time TEXT,
            endTime TEXT,
            status TEXT NOT NULL DEFAULT 'confirmed',
            source TEXT DEFAULT 'manual',
            notes TEXT,
            calendly_uri TEXT UNIQUE,
            staff_id INTEGER REFERENCES {{TENANT}}_staff(id) ON DELETE SET NULL,
            staff_name TEXT,
            deposit_paid INTEGER DEFAULT 0,
            deposit_amount INTEGER DEFAULT 0,
            reminder_sent INTEGER DEFAULT 0,
            cancellation_reason TEXT,
            staffRequested INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        )
    `,
    services: `
        CREATE TABLE IF NOT EXISTS {{TENANT}}_services (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            price TEXT NOT NULL,
            description TEXT,
            branch TEXT NOT NULL DEFAULT 'All Branches',
            durationMinutes INTEGER DEFAULT 60,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        )
    `,
    deals: `
        CREATE TABLE IF NOT EXISTS {{TENANT}}_deals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            description TEXT NOT NULL,
            active BOOLEAN NOT NULL DEFAULT 1,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        )
    `,
    branches: `
        CREATE TABLE IF NOT EXISTS {{TENANT}}_branches (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            number INTEGER UNIQUE NOT NULL,
            name TEXT NOT NULL,
            address TEXT NOT NULL,
            map_link TEXT NOT NULL,
            phone TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        )
    `,
    staff: `
        CREATE TABLE IF NOT EXISTS {{TENANT}}_staff (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            phone TEXT NOT NULL,
            role TEXT NOT NULL,
            branch_id INTEGER REFERENCES {{TENANT}}_branches(id) ON DELETE SET NULL,
            status TEXT NOT NULL DEFAULT 'active',
            requestedCount INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        )
    `,
    salon_timings: `
        CREATE TABLE IF NOT EXISTS {{TENANT}}_salon_timings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            day_type TEXT NOT NULL UNIQUE,
            open_time TEXT NOT NULL,
            close_time TEXT NOT NULL,
            updated_at TEXT DEFAULT (datetime('now'))
        )
    `,
    staff_roles: `
        CREATE TABLE IF NOT EXISTS {{TENANT}}_staff_roles (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            created_at TEXT DEFAULT (datetime('now'))
        )
    `,
    staff_bookings: `
        CREATE TABLE IF NOT EXISTS {{TENANT}}_staff_bookings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            staffId INTEGER NOT NULL REFERENCES {{TENANT}}_staff(id) ON DELETE CASCADE,
            bookingId INTEGER NOT NULL REFERENCES {{TENANT}}_bookings(id) ON DELETE CASCADE,
            branchId INTEGER REFERENCES {{TENANT}}_branches(id) ON DELETE SET NULL,
            startTime TEXT NOT NULL,
            endTime TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'active',
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now')),
            UNIQUE(staffId, bookingId)
        )
    `,
    customer_metrics: `
        CREATE TABLE IF NOT EXISTS {{TENANT}}_customer_metrics (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            phone TEXT NOT NULL,
            name TEXT,
            email TEXT,
            total_bookings INTEGER DEFAULT 0,
            completed INTEGER DEFAULT 0,
            no_shows INTEGER DEFAULT 0,
            cancellations INTEGER DEFAULT 0,
            reschedules INTEGER DEFAULT 0,
            total_spent INTEGER DEFAULT 0,
            preferred_branch TEXT,
            preferred_staff TEXT,
            loyalty_points INTEGER DEFAULT 0,
            notes TEXT,
            last_visit TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now')),
            UNIQUE(phone)
        )
    `,
    booking_audit: `
        CREATE TABLE IF NOT EXISTS {{TENANT}}_booking_audit (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            booking_id INTEGER NOT NULL REFERENCES {{TENANT}}_bookings(id) ON DELETE CASCADE,
            old_status TEXT,
            new_status TEXT,
            changed_by TEXT,
            reason TEXT,
            ip_address TEXT,
            user_agent TEXT,
            changed_at TEXT DEFAULT (datetime('now'))
        )
    `,
    booking_reschedules: `
        CREATE TABLE IF NOT EXISTS {{TENANT}}_booking_reschedules (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            original_booking_id INTEGER NOT NULL REFERENCES {{TENANT}}_bookings(id),
            new_booking_id INTEGER NOT NULL REFERENCES {{TENANT}}_bookings(id),
            old_date TEXT,
            old_time TEXT,
            new_date TEXT,
            new_time TEXT,
            reason TEXT,
            rescheduled_at TEXT DEFAULT (datetime('now'))
        )
    `,
    notification_logs: `
        CREATE TABLE IF NOT EXISTS {{TENANT}}_notification_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            recipient TEXT NOT NULL,
            type TEXT NOT NULL,
            booking_id INTEGER REFERENCES {{TENANT}}_bookings(id),
            status TEXT,
            error TEXT,
            sent_at TEXT DEFAULT (datetime('now'))
        )
    `,
    business_settings: `
        CREATE TABLE IF NOT EXISTS {{TENANT}}_business_settings (
            key TEXT PRIMARY KEY,
            value TEXT,
            description TEXT,
            updated_at TEXT DEFAULT (datetime('now'))
        )
    `,
    app_settings: `
        CREATE TABLE IF NOT EXISTS {{TENANT}}_app_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT DEFAULT (datetime('now'))
        )
    `
};

function getSuperDb() {
    if (!superDb) {
        superDb = new Database(SUPER_DB_PATH);
        superDb.pragma('journal_mode = WAL');
        superDb.pragma('foreign_keys = ON');
        initSuperSchema();
    }
    return superDb;
}

function initSuperSchema() {
    // Create salon_tenants table
    superDb.exec(`
        CREATE TABLE IF NOT EXISTS salon_tenants (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tenant_id TEXT UNIQUE NOT NULL,
            owner_name TEXT NOT NULL,
            salon_name TEXT NOT NULL,
            email TEXT UNIQUE NOT NULL,
            phone TEXT NOT NULL,
            password_hash TEXT NOT NULL,
            status TEXT DEFAULT 'active',
            subscription_plan TEXT DEFAULT 'basic',
            subscription_expires TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        )
    `);
    
    // Add missing columns if needed
    const tableInfo = superDb.prepare("PRAGMA table_info(salon_tenants)").all();
    const hasStatus = tableInfo.some(col => col.name === 'status');
    if (!hasStatus) {
        superDb.exec(`ALTER TABLE salon_tenants ADD COLUMN status TEXT DEFAULT 'active'`);
    }

    const hasSubscriptionPlan = tableInfo.some(col => col.name === 'subscription_plan');
    if (!hasSubscriptionPlan) {
        superDb.exec(`ALTER TABLE salon_tenants ADD COLUMN subscription_plan TEXT DEFAULT 'basic'`);
    }

    const hasSubscriptionExpires = tableInfo.some(col => col.name === 'subscription_expires');
    if (!hasSubscriptionExpires) {
        superDb.exec(`ALTER TABLE salon_tenants ADD COLUMN subscription_expires TEXT`);
    }

    // Create super_admin table
    superDb.exec(`
        CREATE TABLE IF NOT EXISTS super_admin (
            id INTEGER PRIMARY KEY,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            email TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now'))
        )
    `);

    // Seed super admin from env vars if table is empty
    const adminCount = superDb.prepare("SELECT COUNT(*) as count FROM super_admin").get();
    if (adminCount.count === 0) {
        const username = process.env.SUPER_ADMIN_USERNAME || 'superadmin';
        const password = process.env.SUPER_ADMIN_PASSWORD || 'admin123';
        const hash = bcrypt.hashSync(password, 10);
        superDb.prepare("INSERT OR IGNORE INTO super_admin (id, username, password_hash, email) VALUES (1, ?, ?, ?)").run(username, hash, 'super@salon.com');
        console.log('✅ Super admin seeded from env:', username);
    }

    // Create tenant_settings table
    superDb.exec(`
        CREATE TABLE IF NOT EXISTS tenant_settings (
            tenant_id TEXT NOT NULL,
            setting_key TEXT NOT NULL,
            setting_value TEXT,
            updated_at TEXT DEFAULT (datetime('now')),
            PRIMARY KEY (tenant_id, setting_key)
        )
    `);

    // Create super_admin_audit table
    superDb.exec(`
        CREATE TABLE IF NOT EXISTS super_admin_audit (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            admin_username TEXT,
            action TEXT,
            target_tenant TEXT,
            details TEXT,
            ip_address TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        )
    `);

    // Per-tenant webhook credentials (replaces global .env tokens per salon)
    superDb.exec(`
        CREATE TABLE IF NOT EXISTS tenant_webhook_configs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tenant_id TEXT NOT NULL UNIQUE,
            wa_phone_number_id TEXT,
            wa_access_token TEXT,
            wa_verify_token TEXT,
            ig_page_access_token TEXT,
            ig_verify_token TEXT,
            fb_page_access_token TEXT,
            fb_verify_token TEXT,
            wa_webhook_verified INTEGER DEFAULT 0,
            ig_webhook_verified INTEGER DEFAULT 0,
            fb_webhook_verified INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        )
    `);
    // Migrate: add verified columns to existing tables if not present
    for (const col of ['wa_webhook_verified', 'ig_webhook_verified', 'fb_webhook_verified']) {
        try {
            superDb.exec(`ALTER TABLE tenant_webhook_configs ADD COLUMN ${col} INTEGER DEFAULT 0`);
        } catch (_) { /* column already exists */ }
    }

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
    // Migration: ensure widget_access column exists on plans (Phase 2 FEAT-05, FEAT-07)
    try {
        superDb.exec(`ALTER TABLE plans ADD COLUMN widget_access INTEGER NOT NULL DEFAULT 0`);
    } catch (_) { /* column already exists */ }

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

    // Migration: add cors_origin to salon_tenants (Phase 2, plan 02-05)
    try {
        superDb.prepare(`ALTER TABLE salon_tenants ADD COLUMN cors_origin TEXT DEFAULT NULL`).run();
    } catch (e) { /* column already exists */ }

}

function generateTenantId() {
    const db = getSuperDb();
    const last = db.prepare("SELECT tenant_id FROM salon_tenants ORDER BY id DESC LIMIT 1").get();
    if (!last) return 'SA_01';
    const num = parseInt(last.tenant_id.split('_')[1]) + 1;
    return `SA_${String(num).padStart(2, '0')}`;
}

async function createTenant(ownerName, salonName, email, phone, password) {
    const db = getSuperDb();
    const tenantId = generateTenantId();
    const passwordHash = await bcrypt.hash(password, 10);

    const insert = db.prepare(`
        INSERT INTO salon_tenants (tenant_id, owner_name, salon_name, email, phone, password_hash)
        VALUES (?, ?, ?, ?, ?, ?)
    `);
    insert.run(tenantId, ownerName, salonName, email, phone, passwordHash);

    // Create tenant-specific tables in the main salon.db
    await createTenantTables(tenantId);

    // Seed default data for the tenant
    await seedTenantData(tenantId, salonName);

    return tenantId;
}

function createTenantTables(tenantId) {
    const { getDb } = require('./database');
    const db = getDb(); // This returns the main salon.db connection

    const transaction = db.transaction(() => {
        for (const [tableName, template] of Object.entries(TENANT_TABLE_TEMPLATES)) {
            const sql = template.replace(/{{TENANT}}/g, tenantId);
            db.exec(sql);
        }
    });

    transaction();
    logger.info(`[Tenant] Created tables for ${tenantId}`);
}

function seedTenantData(tenantId, salonName) {
    const { getDb } = require('./database');
    const db = getDb();

    // Default deals
    const insertDeal = db.prepare(`
        INSERT INTO ${tenantId}_deals (title, description, active) VALUES (?, ?, ?)
    `);

    const deals = [
        ['Weekend Special', 'Get 20% off all hair services every Saturday and Sunday!', 1],
        ['New Client Offer', 'First visit? Enjoy a complimentary hair treatment with any service.', 1],
    ];
    for (const deal of deals) insertDeal.run(...deal);

    // Default salon timings
    db.prepare(`
        INSERT INTO ${tenantId}_salon_timings (day_type, open_time, close_time) VALUES (?, ?, ?)
    `).run('workday', '10:00', '21:00');
    db.prepare(`
        INSERT INTO ${tenantId}_salon_timings (day_type, open_time, close_time) VALUES (?, ?, ?)
    `).run('weekend', '12:00', '22:00');

    // Default staff roles
    const roles = ['stylist', 'receptionist', 'manager', 'admin'];
    const insertRole = db.prepare(`INSERT INTO ${tenantId}_staff_roles (name) VALUES (?)`);
    for (const role of roles) insertRole.run(role);

    // Default currency
    db.prepare(`
        INSERT INTO ${tenantId}_app_settings (key, value) VALUES ('currency', 'Rs.')
    `).run();

    // Default business settings
    const settings = [
        ['cancellation_hours', '24', 'Hours before appointment to cancel without fee'],
        ['no_show_grace_minutes', '30', 'Minutes after appointment to mark as no-show'],
        ['deposit_percentage', '0', 'Percentage deposit required for booking'],
        ['reminder_hours', '24', 'Hours before to send reminder'],
        ['max_reschedules', '2', 'Maximum times a booking can be rescheduled']
    ];
    const insertSetting = db.prepare(`
        INSERT INTO ${tenantId}_business_settings (key, value, description) VALUES (?, ?, ?)
    `);
    for (const setting of settings) insertSetting.run(...setting);

    logger.info(`[Tenant] Seeded default data for ${tenantId}`);
}

function authenticateTenant(email, password) {
    const db = getSuperDb();
    const tenant = db.prepare(`
        SELECT * FROM salon_tenants WHERE email = ? AND status = 'active'
    `).get(email);

    if (!tenant) return null;

    const valid = bcrypt.compareSync(password, tenant.password_hash);
    return valid ? tenant : null;
}

function getTenantByEmail(email) {
    const db = getSuperDb();
    return db.prepare(`SELECT * FROM salon_tenants WHERE email = ?`).get(email);
}

function getTenantById(tenantId) {
    const db = getSuperDb();
    return db.prepare('SELECT * FROM salon_tenants WHERE tenant_id = ?').get(tenantId);
}

function getAllTenants() {
    const db = getSuperDb();
    return db.prepare(`
        SELECT st.id, st.tenant_id, st.owner_name, st.salon_name, st.email, st.phone, st.status,
               COALESCE(p.name, st.subscription_plan) AS subscription_plan,
               COALESCE(s.current_period_end, st.subscription_expires) AS subscription_expires,
               st.created_at
        FROM salon_tenants st
        LEFT JOIN subscriptions s ON s.tenant_id = st.tenant_id AND s.status = 'active'
        LEFT JOIN plans p ON p.id = s.plan_id
        ORDER BY st.created_at DESC
    `).all();
}

function updateTenantStatus(tenantId, status) {
    const db = getSuperDb();
    db.prepare(`UPDATE salon_tenants SET status = ?, updated_at = datetime('now') WHERE tenant_id = ?`).run(status, tenantId);
}

function updateTenantPassword(tenantId, newPassword) {
    const db = getSuperDb();
    const hash = bcrypt.hashSync(newPassword, 10);
    db.prepare(`UPDATE salon_tenants SET password_hash = ?, updated_at = datetime('now') WHERE tenant_id = ?`).run(hash, tenantId);
}

function changeSuperAdminPassword(username, newPassword) {
    const db = getSuperDb();
    const hash = bcrypt.hashSync(newPassword, 10);
    db.prepare(`UPDATE super_admin SET password_hash = ? WHERE username = ?`).run(hash, username);
}

function updateSalonName(tenantId, newSalonName) {
    const db = getSuperDb();
    db.prepare(`UPDATE salon_tenants SET salon_name = ?, updated_at = datetime('now') WHERE tenant_id = ?`).run(newSalonName, tenantId);

    // Also update tenant_settings for widget
    const settingDb = getSuperDb();
    settingDb.prepare(`
        INSERT OR REPLACE INTO tenant_settings (tenant_id, setting_key, setting_value, updated_at)
        VALUES (?, 'salon_name', ?, datetime('now'))
    `).run(tenantId, newSalonName);
}

function getTenantSetting(tenantId, key) {
    const db = getSuperDb();
    const result = db.prepare(`SELECT setting_value FROM tenant_settings WHERE tenant_id = ? AND setting_key = ?`).get(tenantId, key);
    return result ? result.setting_value : null;
}

function setTenantSetting(tenantId, key, value) {
    const db = getSuperDb();
    db.prepare(`
        INSERT OR REPLACE INTO tenant_settings (tenant_id, setting_key, setting_value, updated_at)
        VALUES (?, ?, ?, datetime('now'))
    `).run(tenantId, key, value);
}

// ── Update subscription by tenant_id (for upgrades/downgrades) ─────────────────
function updateSubscriptionByTenantId(tenantId, { planId, status, currentPeriodStart, currentPeriodEnd, updatedAt } = {}) {
    const db = getSuperDb();

    // Get the current active subscription for this tenant
    const currentSub = db.prepare(`
        SELECT id, plan_id FROM subscriptions 
        WHERE tenant_id = ? AND status = 'active' 
        ORDER BY created_at DESC LIMIT 1
    `).get(tenantId);

    if (!currentSub) {
        // No active subscription found, create a new one
        const now = new Date();
        const periodStart = currentPeriodStart || now.toISOString();
        let periodEnd = currentPeriodEnd;

        if (!periodEnd && planId) {
            const plan = getPlanById(planId);
            if (plan) {
                const end = new Date(now);
                if (plan.billing_cycle === 'yearly') {
                    end.setFullYear(end.getFullYear() + 1);
                } else {
                    end.setMonth(end.getMonth() + 1);
                }
                periodEnd = end.toISOString();
            }
        }

        const result = db.prepare(`
            INSERT INTO subscriptions (tenant_id, plan_id, status, current_period_start, current_period_end)
            VALUES (?, ?, ?, ?, ?)
        `).run(tenantId, planId || currentSub?.plan_id, status || 'active', periodStart, periodEnd);

        // Update salon_tenants denormalized fields
        if (planId) {
            const plan = getPlanById(planId);
            if (plan) {
                db.prepare(`
                    UPDATE salon_tenants 
                    SET subscription_plan = ?, subscription_expires = ?, updated_at = datetime('now')
                    WHERE tenant_id = ?
                `).run(plan.name, periodEnd, tenantId);
            }
        }

        return db.prepare(`SELECT * FROM subscriptions WHERE id = ?`).get(result.lastInsertRowid);
    }

    // Update existing subscription
    db.transaction(() => {
        const fields = [];
        const values = [];

        if (planId !== undefined) {
            fields.push('plan_id = ?');
            values.push(planId);

            // Update salon_tenants subscription_plan name
            const plan = getPlanById(planId);
            if (plan) {
                db.prepare(`
                    UPDATE salon_tenants 
                    SET subscription_plan = ?, updated_at = datetime('now')
                    WHERE tenant_id = ?
                `).run(plan.name, tenantId);
            }
        }
        if (status !== undefined) { fields.push('status = ?'); values.push(status); }
        if (currentPeriodStart !== undefined) { fields.push('current_period_start = ?'); values.push(currentPeriodStart); }
        if (currentPeriodEnd !== undefined) {
            fields.push('current_period_end = ?');
            values.push(currentPeriodEnd);

            // Update salon_tenants subscription_expires
            db.prepare(`
                UPDATE salon_tenants 
                SET subscription_expires = ?, updated_at = datetime('now')
                WHERE tenant_id = ?
            `).run(currentPeriodEnd, tenantId);
        }

        if (fields.length === 0) return;

        fields.push("updated_at = datetime('now')");
        values.push(currentSub.id);

        db.prepare(`UPDATE subscriptions SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    })();

    // After updating, apply service freeze/unfreeze based on new plan limits
    if (planId !== undefined) {
        const newPlan = getPlanById(planId);
        if (newPlan && Number.isFinite(newPlan.max_services)) {
            freezeExcessServices(tenantId, newPlan.max_services);
            unfreezeServices(tenantId, newPlan.max_services);
            logger.info(`[subscription] Applied service limits for ${tenantId} (max_services=${newPlan.max_services})`);
        }
    }

    return getTenantSubscription(tenantId);
}

function isTenantActive(tenantId) {
    const db = getSuperDb();
    const tenant = db.prepare('SELECT status FROM salon_tenants WHERE tenant_id = ?').get(tenantId);
    return tenant ? tenant.status === 'active' : false;
}

function getTenantAccessStatus(tenantId) {
    const db = getSuperDb();
    const tenant = db.prepare(
        'SELECT status, subscription_expires FROM salon_tenants WHERE tenant_id = ?'
    ).get(tenantId);
    if (!tenant) return { active: false, reason: 'not_found' };
    if (tenant.status !== 'active') return { active: false, reason: 'suspended' };

    // Look up the active subscription + its plan
    const sub = db.prepare(`
        SELECT s.current_period_end, p.is_active AS plan_is_active
        FROM subscriptions s
        JOIN plans p ON p.id = s.plan_id
        WHERE s.tenant_id = ? AND s.status = 'active'
        ORDER BY s.created_at DESC LIMIT 1
    `).get(tenantId);

    if (sub) {
        // Plan deactivated check runs BEFORE expiry check
        if (sub.plan_is_active === 0) {
            return { active: false, reason: 'plan_deactivated' };
        }
        if (sub.current_period_end) {
            const end = new Date(sub.current_period_end).getTime();
            if (Number.isFinite(end) && end < Date.now()) {
                return { active: false, reason: 'subscription_expired' };
            }
        }
        return { active: true, reason: 'active' };
    }

    // No subscription row — fall back to legacy salon_tenants.subscription_expires
    if (tenant.subscription_expires) {
        const legacyEnd = new Date(tenant.subscription_expires).getTime();
        if (Number.isFinite(legacyEnd) && legacyEnd < Date.now()) {
            return { active: false, reason: 'subscription_expired' };
        }
    }
    return { active: true, reason: 'active' };
}

// ── Per-tenant webhook config ─────────────────────────────────────────────────

function getWebhookConfig(tenantId) {
    const db = getSuperDb();
    return db.prepare('SELECT * FROM tenant_webhook_configs WHERE tenant_id = ?').get(tenantId) || null;
}

function markWebhookVerified(tenantId, platform) {
    const col = { whatsapp: 'wa_webhook_verified', instagram: 'ig_webhook_verified', facebook: 'fb_webhook_verified' }[platform];
    if (!col) return;
    const db = getSuperDb();
    db.prepare(`UPDATE tenant_webhook_configs SET ${col} = 1, updated_at = datetime('now') WHERE tenant_id = ?`).run(tenantId);
}

function upsertWebhookConfig(tenantId, config) {
    const db = getSuperDb();
    const {
        wa_phone_number_id = null,
        wa_access_token = null,
        wa_verify_token = null,
        ig_page_access_token = null,
        ig_verify_token = null,
        fb_page_access_token = null,
        fb_verify_token = null,
    } = config;

    db.prepare(`
        INSERT INTO tenant_webhook_configs
            (tenant_id, wa_phone_number_id, wa_access_token, wa_verify_token,
             ig_page_access_token, ig_verify_token,
             fb_page_access_token, fb_verify_token, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(tenant_id) DO UPDATE SET
            wa_phone_number_id  = COALESCE(excluded.wa_phone_number_id, tenant_webhook_configs.wa_phone_number_id),
            wa_access_token     = COALESCE(excluded.wa_access_token, tenant_webhook_configs.wa_access_token),
            wa_verify_token     = COALESCE(excluded.wa_verify_token, tenant_webhook_configs.wa_verify_token),
            ig_page_access_token = COALESCE(excluded.ig_page_access_token, tenant_webhook_configs.ig_page_access_token),
            ig_verify_token     = COALESCE(excluded.ig_verify_token, tenant_webhook_configs.ig_verify_token),
            fb_page_access_token = COALESCE(excluded.fb_page_access_token, tenant_webhook_configs.fb_page_access_token),
            fb_verify_token     = COALESCE(excluded.fb_verify_token, tenant_webhook_configs.fb_verify_token),
            wa_webhook_verified = CASE WHEN excluded.wa_access_token IS NOT NULL OR excluded.wa_verify_token IS NOT NULL THEN 0 ELSE tenant_webhook_configs.wa_webhook_verified END,
            ig_webhook_verified = CASE WHEN excluded.ig_page_access_token IS NOT NULL OR excluded.ig_verify_token IS NOT NULL THEN 0 ELSE tenant_webhook_configs.ig_webhook_verified END,
            fb_webhook_verified = CASE WHEN excluded.fb_page_access_token IS NOT NULL OR excluded.fb_verify_token IS NOT NULL THEN 0 ELSE tenant_webhook_configs.fb_webhook_verified END,
            updated_at          = excluded.updated_at
    `).run(tenantId, wa_phone_number_id, wa_access_token, wa_verify_token,
            ig_page_access_token, ig_verify_token,
            fb_page_access_token, fb_verify_token);
}

function clearWebhookChannel(tenantId, channel) {
    const db = getSuperDb();
    const fieldMap = {
        whatsapp: `wa_phone_number_id = NULL, wa_access_token = NULL, wa_verify_token = NULL, wa_webhook_verified = 0`,
        instagram: `ig_page_access_token = NULL, ig_verify_token = NULL, ig_webhook_verified = 0`,
        facebook: `fb_page_access_token = NULL, fb_verify_token = NULL, fb_webhook_verified = 0`,
    };
    const fields = fieldMap[channel];
    if (!fields) return;
    db.prepare(`UPDATE tenant_webhook_configs SET ${fields}, updated_at = datetime('now') WHERE tenant_id = ?`).run(tenantId);
}

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

function hardDeletePlan(planId) {
    const db = getSuperDb();
    db.prepare(`DELETE FROM plans WHERE id = ?`).run(planId);
}

// ── Subscriptions ─────────────────────────────────────────────────────────────

function createSubscription(tenantId, planId, stripeSubId, stripeCustomerId, periodStart, periodEnd) {
    const db = getSuperDb();
    const plan = db.prepare(`SELECT name, billing_cycle FROM plans WHERE id = ?`).get(planId);

    // Derive period dates from plan billing cycle if not supplied by caller
    if (!periodStart || !periodEnd) {
        const now = new Date();
        periodStart = periodStart || now.toISOString();
        if (plan) {
            const end = new Date(now);
            if (plan.billing_cycle === 'yearly') {
                end.setFullYear(end.getFullYear() + 1);
            } else {
                end.setMonth(end.getMonth() + 1);
            }
            periodEnd = end.toISOString();
        }
    }

    const result = db.prepare(`
        INSERT INTO subscriptions (tenant_id, plan_id, stripe_subscription_id, stripe_customer_id,
            status, current_period_start, current_period_end)
        VALUES (?, ?, ?, ?, 'active', ?, ?)
    `).run(tenantId, planId, stripeSubId || null, stripeCustomerId || null, periodStart, periodEnd);

    if (plan) {
        db.prepare(`
            UPDATE salon_tenants
            SET subscription_plan = ?, subscription_expires = ?, updated_at = datetime('now')
            WHERE tenant_id = ?
        `).run(plan.name, periodEnd, tenantId);
    }

    return db.prepare(`SELECT * FROM subscriptions WHERE id = ?`).get(result.lastInsertRowid);
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

// ── Service Freeze / Unfreeze Helpers (PLN-02, PLN-05) ────────────────────────

/**
 * Freeze the oldest-first non-frozen services so that active count <= maxServices.
 * Called when a tenant downgrades to a plan with lower max_services.
 * No-op if active count already <= maxServices.
 */
function freezeExcessServices(tenantId, maxServices) {
    if (!tenantId || !Number.isFinite(maxServices) || maxServices < 0) return 0;
    const { getDb } = require('./database');
    const db = getDb();
    try {
        const activeCount = db.prepare(
            `SELECT COUNT(*) AS cnt FROM ${tenantId}_services WHERE frozen = 0`
        ).get().cnt;
        if (activeCount <= maxServices) return 0;

        const toFreeze = activeCount - maxServices;
        const rows = db.prepare(
            `SELECT id FROM ${tenantId}_services WHERE frozen = 0 ORDER BY created_at ASC LIMIT ?`
        ).all(toFreeze);
        const update = db.prepare(
            `UPDATE ${tenantId}_services SET frozen = 1, updated_at = datetime('now') WHERE id = ?`
        );
        db.transaction(() => {
            for (const r of rows) update.run(r.id);
        })();
        logger.info(`[freeze] Froze ${rows.length} services for ${tenantId} (maxServices=${maxServices})`);
        try {
            const { patchCache } = require('../cache/salonDataCache');
            const fresh = db.prepare(`SELECT * FROM ${tenantId}_services WHERE frozen = 0 ORDER BY branch, name`).all();
            patchCache(tenantId, 'services', 'replace', fresh).catch(() => {});
        } catch (_) {}
        return rows.length;
    } catch (err) {
        logger.error(`[freeze] freezeExcessServices failed for ${tenantId}:`, err.message);
        return 0;
    }
}

/**
 * Unfreeze oldest-frozen-first services so that active count rises toward maxServices.
 * Called when a tenant upgrades to a plan with higher max_services.
 * No-op if active count already >= maxServices.
 * Uses updated_at ASC because that reflects the freeze order (rows were stamped when frozen).
 */
function unfreezeServices(tenantId, maxServices) {
    if (!tenantId || !Number.isFinite(maxServices) || maxServices < 0) return 0;
    const { getDb } = require('./database');
    const db = getDb();
    try {
        const activeCount = db.prepare(
            `SELECT COUNT(*) AS cnt FROM ${tenantId}_services WHERE frozen = 0`
        ).get().cnt;
        if (activeCount >= maxServices) return 0;

        const toUnfreeze = maxServices - activeCount;
        const rows = db.prepare(
            `SELECT id FROM ${tenantId}_services WHERE frozen = 1 ORDER BY updated_at ASC LIMIT ?`
        ).all(toUnfreeze);
        const update = db.prepare(
            `UPDATE ${tenantId}_services SET frozen = 0, updated_at = datetime('now') WHERE id = ?`
        );
        db.transaction(() => {
            for (const r of rows) update.run(r.id);
        })();
        logger.info(`[freeze] Unfroze ${rows.length} services for ${tenantId} (maxServices=${maxServices})`);
        try {
            const { patchCache } = require('../cache/salonDataCache');
            const fresh = db.prepare(`SELECT * FROM ${tenantId}_services WHERE frozen = 0 ORDER BY branch, name`).all();
            patchCache(tenantId, 'services', 'replace', fresh).catch(() => {});
        } catch (_) {}
        return rows.length;
    } catch (err) {
        logger.error(`[freeze] unfreezeServices failed for ${tenantId}:`, err.message);
        return 0;
    }
}

// function getTenantSubscription(tenantId) {
//     const db = getSuperDb();
//     return db.prepare(`
//         SELECT s.*, p.name as plan_name, p.max_services, p.whatsapp_access,
//                p.instagram_access, p.facebook_access, p.ai_calls_access,
//                p.widget_access
//         FROM subscriptions s
//         JOIN plans p ON p.id = s.plan_id
//         WHERE s.tenant_id = ? AND s.status = 'active'
//         ORDER BY s.created_at DESC LIMIT 1
//     `).get(tenantId) || null;
// }

// ── Get tenant's current subscription with full plan details ─────────────────
function getTenantSubscription(tenantId) {
    try {
        const db = getSuperDb();
        const subscription = db.prepare(`
            SELECT s.*, 
                   p.name as plan_name, 
                   p.price_cents,
                   p.billing_cycle,
                   p.max_services, 
                   p.whatsapp_access,
                   p.instagram_access, 
                   p.facebook_access, 
                   p.ai_calls_access,
                   p.widget_access
            FROM subscriptions s
            JOIN plans p ON p.id = s.plan_id
            WHERE s.tenant_id = ? AND s.status = 'active'
            ORDER BY s.created_at DESC LIMIT 1
        `).get(tenantId);
        
        if (!subscription) {
            console.log(`[getTenantSubscription] No active subscription found for ${tenantId}`);
            return null;
        }
        
        // Calculate remaining days if current_period_end exists
        let remainingDays = null;
        let remainingDaysText = null;
        
        if (subscription.current_period_end) {
            const endDate = new Date(subscription.current_period_end);
            const now = new Date();
            
            if (endDate > now) {
                const diffTime = endDate - now;
                const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
                remainingDays = diffDays;
                
                if (diffDays === 1) {
                    remainingDaysText = "1 day remaining";
                } else if (diffDays <= 7) {
                    remainingDaysText = `${diffDays} days remaining`;
                } else if (diffDays <= 30) {
                    const weeks = Math.floor(diffDays / 7);
                    remainingDaysText = `${weeks} week${weeks > 1 ? 's' : ''} remaining`;
                } else {
                    const months = Math.floor(diffDays / 30);
                    remainingDaysText = `${months} month${months > 1 ? 's' : ''} remaining`;
                }
            } else {
                remainingDaysText = "Expired";
            }
        }
        
        return {
            ...subscription,
            remaining_days: remainingDays,
            remaining_days_text: remainingDaysText
        };
    } catch (err) {
        console.error(`[getTenantSubscription] Error for ${tenantId}:`, err.message);
        return null;
    }
}
// ── Subscription updates (SUB-01, SUB-02, SUB-03) ─────────────────────────────

function updateSubscription(stripeSubscriptionId, { planId, status, currentPeriodStart, currentPeriodEnd } = {}) {
    const db = getSuperDb();
    db.transaction(() => {
        const fields = [];
        const values = [];
        if (planId !== undefined) { fields.push('plan_id = ?'); values.push(planId); }
        if (status !== undefined) { fields.push('status = ?'); values.push(status); }
        if (currentPeriodStart !== undefined) { fields.push('current_period_start = ?'); values.push(currentPeriodStart); }
        if (currentPeriodEnd !== undefined) { fields.push('current_period_end = ?'); values.push(currentPeriodEnd); }
        if (!fields.length) return;
        fields.push("updated_at = datetime('now')");
        values.push(stripeSubscriptionId);
        db.prepare(`UPDATE subscriptions SET ${fields.join(', ')} WHERE stripe_subscription_id = ?`).run(...values);

        // Keep salon_tenants denormalized columns in sync
        const row = db.prepare('SELECT tenant_id, plan_id FROM subscriptions WHERE stripe_subscription_id = ?').get(stripeSubscriptionId);
        if (row) {
            const planRow = db.prepare('SELECT name FROM plans WHERE id = ?').get(planId !== undefined ? planId : row.plan_id);
            const setParts = [];
            const setValues = [];
            if (currentPeriodEnd !== undefined) { setParts.push('subscription_expires = ?'); setValues.push(currentPeriodEnd); }
            if (planRow && planId !== undefined) { setParts.push('subscription_plan = ?'); setValues.push(planRow.name); }
            if (setParts.length) {
                setParts.push("updated_at = datetime('now')");
                setValues.push(row.tenant_id);
                db.prepare(`UPDATE salon_tenants SET ${setParts.join(', ')} WHERE tenant_id = ?`).run(...setValues);
            }
        }
    })();

    // PLN-02 / PLN-05: freeze or unfreeze services based on the new plan's max_services.
    // Must happen AFTER the subscription transaction commits.
    if (planId !== undefined) {
        const tenantRow = db.prepare('SELECT tenant_id FROM subscriptions WHERE stripe_subscription_id = ?').get(stripeSubscriptionId);
        const planRow = db.prepare('SELECT max_services FROM plans WHERE id = ?').get(planId);
        if (tenantRow && planRow && Number.isFinite(planRow.max_services)) {
            freezeExcessServices(tenantRow.tenant_id, planRow.max_services);
            unfreezeServices(tenantRow.tenant_id, planRow.max_services);
        }
    }
}

function cancelSubscription(stripeSubscriptionId, cancellationDate) {
    const db = getSuperDb();
    db.transaction(() => {
        db.prepare(`UPDATE subscriptions SET status = 'canceled', updated_at = datetime('now') WHERE stripe_subscription_id = ?`).run(stripeSubscriptionId);
        const row = db.prepare('SELECT tenant_id FROM subscriptions WHERE stripe_subscription_id = ?').get(stripeSubscriptionId);
        if (row) {
            db.prepare(`UPDATE salon_tenants SET subscription_expires = ?, updated_at = datetime('now') WHERE tenant_id = ?`).run(cancellationDate, row.tenant_id);
        }
    })();
}

function setTenantPlanOverride(tenantId, planId) {
    const db = getSuperDb();
    db.transaction(() => {
        const plan = db.prepare('SELECT name, billing_cycle FROM plans WHERE id = ?').get(planId);
        if (!plan) throw new Error(`Plan ${planId} not found`);

        const now = new Date();
        const periodStart = now.toISOString();
        let periodEnd = null;
        if (plan.billing_cycle === 'monthly') {
            const end = new Date(now);
            end.setMonth(end.getMonth() + 1);
            periodEnd = end.toISOString();
        } else if (plan.billing_cycle === 'yearly') {
            const end = new Date(now);
            end.setFullYear(end.getFullYear() + 1);
            periodEnd = end.toISOString();
        }

        const existing = db.prepare('SELECT id FROM subscriptions WHERE tenant_id = ? AND status = ?').get(tenantId, 'active');
        if (existing) {
            db.prepare(`UPDATE subscriptions SET plan_id = ?, current_period_start = ?, current_period_end = ?, updated_at = datetime('now') WHERE id = ?`).run(planId, periodStart, periodEnd, existing.id);
        } else {
            db.prepare(`INSERT INTO subscriptions (tenant_id, plan_id, status, current_period_start, current_period_end) VALUES (?, ?, 'active', ?, ?)`).run(tenantId, planId, periodStart, periodEnd);
        }

        db.prepare(`UPDATE salon_tenants SET subscription_plan = ?, subscription_expires = ?, updated_at = datetime('now') WHERE tenant_id = ?`).run(plan.name, periodEnd, tenantId);
    })();

    // PLN-02 / PLN-05: freeze or unfreeze services based on the new plan's max_services.
    // Must happen AFTER the override transaction commits.
    const planRow = db.prepare('SELECT max_services FROM plans WHERE id = ?').get(planId);
    if (planRow && Number.isFinite(planRow.max_services)) {
        const frozen = freezeExcessServices(tenantId, planRow.max_services);
        const unfrozen = unfreezeServices(tenantId, planRow.max_services);
        logger.info(`[admin plan override] freeze result for ${tenantId}: frozen=${frozen} unfrozen=${unfrozen} maxServices=${planRow.max_services}`);
    } else {
        logger.warn(`[admin plan override] could not enforce plan limits for ${tenantId}: planRow=${JSON.stringify(planRow)}`);
    }
}

// ── Password Reset Tokens ─────────────────────────────────────────────────────

function storeResetToken(tenantId, tokenHash, expiresAt) {
    const db = getSuperDb();
    db.transaction(() => {
        db.prepare(`DELETE FROM password_reset_tokens WHERE tenant_id = ?`).run(tenantId);
        // Periodic cleanup of expired and used tokens across all tenants
        db.prepare(`DELETE FROM password_reset_tokens WHERE used = 1 OR expires_at < datetime('now')`).run();
        db.prepare(`
            INSERT INTO password_reset_tokens (tenant_id, token_hash, expires_at)
            VALUES (?, ?, ?)
        `).run(tenantId, tokenHash, expiresAt);
    })();
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

// ── CORS Origin per-tenant ────────────────────────────────────────────────────

function getTenantCorsOrigin(tenantId) {
    const db = getSuperDb();
    const row = db.prepare('SELECT cors_origin FROM salon_tenants WHERE tenant_id = ?').get(tenantId);
    return row ? row.cors_origin : null;
}

function setTenantCorsOrigin(tenantId, origin) {
    const db = getSuperDb();
    db.prepare('UPDATE salon_tenants SET cors_origin = ? WHERE tenant_id = ?').run(origin, tenantId);
}

function closeConnections() {
    if (superDb) {
        superDb.close();
        superDb = null;
    }
}

module.exports = {
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
    getTenantAccessStatus,
    getWebhookConfig,
    upsertWebhookConfig,
    clearWebhookChannel,
    getAllPlans,
    getActivePlans,
    getPlanById,
    createPlan,
    updatePlan,
    deletePlan,
    hardDeletePlan,
    createSubscription,
    updateSubscription,
    cancelSubscription,
    setTenantPlanOverride,
    getSubscriptions,
    storeResetToken,
    getValidResetToken,
    markResetTokenUsed,
    getTenantSubscription,
    updateSubscriptionByTenantId,
    freezeExcessServices,
    unfreezeServices,
    getTenantCorsOrigin,
    setTenantCorsOrigin,
    closeConnections,
};
