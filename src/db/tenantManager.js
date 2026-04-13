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
    return db.prepare(`SELECT id, tenant_id, owner_name, salon_name, email, phone, status, subscription_plan, subscription_expires, created_at FROM salon_tenants ORDER BY created_at DESC`).all();
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

function isTenantActive(tenantId) {
    const db = getSuperDb();
    const tenant = db.prepare('SELECT status FROM salon_tenants WHERE tenant_id = ?').get(tenantId);
    return tenant && tenant.status === 'active';
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
    getWebhookConfig,
    upsertWebhookConfig,
    clearWebhookChannel,
};