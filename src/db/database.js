const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../salon.db');
const SUPER_DB_PATH = process.env.SUPER_DB_PATH || path.join(__dirname, '../../super.db');

let db;
let _settingsCache = null;

function getSettings(tenantId = null) {
  const tid = tenantId || currentTenantId;
  if (!tid) return {};

  if (_settingsCache && _settingsCache[tid]) return _settingsCache[tid];

  const tableName = `${tid}_app_settings`;
  try {
    const rows = getDb().prepare(`SELECT key, value FROM ${tableName}`).all();
    if (!_settingsCache) _settingsCache = {};
    _settingsCache[tid] = {};
    rows.forEach(r => { _settingsCache[tid][r.key] = r.value; });
    return _settingsCache[tid];
  } catch (error) {
    console.error(`Error getting settings for tenant ${tid}:`, error.message);
    return {};
  }
}

function invalidateSettingsCache() {
  _settingsCache = null;
}

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
  }
  return db;
}

// Create ALL tables for a tenant with proper prefix
function createTenantTables(tenantId) {
  const db = getDb();
  console.log(`📦 Creating ALL tables for tenant ${tenantId}...`);

  const tables = {
    deals: `${tenantId}_deals`,
    services: `${tenantId}_services`,
    staff_roles: `${tenantId}_staff_roles`,
    salon_timings: `${tenantId}_salon_timings`,
    bookings: `${tenantId}_bookings`,
    branches: `${tenantId}_branches`,
    staff: `${tenantId}_staff`,
    app_settings: `${tenantId}_app_settings`,
    business_settings: `${tenantId}_business_settings`,
    customer_metrics: `${tenantId}_customer_metrics`,
    booking_audit: `${tenantId}_booking_audit`,
    booking_reschedules: `${tenantId}_booking_reschedules`,
    notification_logs: `${tenantId}_notification_logs`,
    staff_bookings: `${tenantId}_staff_bookings`
  };

  // Create ALL tenant tables
  db.exec(`
    -- Deals table
    CREATE TABLE IF NOT EXISTS ${tables.deals} (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      title       TEXT    NOT NULL,
      description TEXT    NOT NULL,
      active      BOOLEAN NOT NULL DEFAULT 1,
      created_at  TEXT    DEFAULT (datetime('now')),
      updated_at  TEXT    DEFAULT (datetime('now'))
    );

    -- Services table
    CREATE TABLE IF NOT EXISTS ${tables.services} (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      name            TEXT    NOT NULL,
      price           TEXT    NOT NULL,
      description     TEXT,
      branch          TEXT    NOT NULL DEFAULT 'All Branches',
      durationMinutes INTEGER DEFAULT 60,
      created_at      TEXT    DEFAULT (datetime('now')),
      updated_at      TEXT    DEFAULT (datetime('now'))
    );

    -- Staff Roles table
    CREATE TABLE IF NOT EXISTS ${tables.staff_roles} (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL UNIQUE,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Salon Timings table
    CREATE TABLE IF NOT EXISTS ${tables.salon_timings} (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      day_type   TEXT NOT NULL UNIQUE,
      open_time  TEXT NOT NULL,
      close_time TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- Branches table
    CREATE TABLE IF NOT EXISTS ${tables.branches} (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      number     INTEGER UNIQUE NOT NULL,
      name       TEXT NOT NULL,
      address    TEXT NOT NULL,
      map_link   TEXT NOT NULL,
      phone      TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- Staff table
    CREATE TABLE IF NOT EXISTS ${tables.staff} (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      name           TEXT    NOT NULL,
      phone          TEXT    NOT NULL,
      role           TEXT    NOT NULL,
      branch_id      INTEGER REFERENCES ${tables.branches}(id) ON DELETE SET NULL,
      status         TEXT    NOT NULL DEFAULT 'active',
      requestedCount INTEGER DEFAULT 0,
      created_at     TEXT    DEFAULT (datetime('now')),
      updated_at     TEXT    DEFAULT (datetime('now'))
    );

    -- Bookings table
    CREATE TABLE IF NOT EXISTS ${tables.bookings} (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_name TEXT    NOT NULL,
      phone         TEXT,
      service       TEXT,
      branch        TEXT,
      date          TEXT,
      time          TEXT,
      endTime       TEXT,
      status        TEXT    NOT NULL DEFAULT 'confirmed',
      source        TEXT    DEFAULT 'manual',
      notes         TEXT,
      calendly_uri  TEXT    UNIQUE,
      staff_id      INTEGER REFERENCES ${tables.staff}(id) ON DELETE SET NULL,
      staff_name    TEXT,
      deposit_paid  INTEGER DEFAULT 0,
      deposit_amount INTEGER DEFAULT 0,
      reminder_sent INTEGER DEFAULT 0,
      cancellation_reason TEXT,
      staffRequested INTEGER DEFAULT 0,
      created_at    TEXT    DEFAULT (datetime('now')),
      updated_at    TEXT    DEFAULT (datetime('now'))
    );

    -- App settings table
    CREATE TABLE IF NOT EXISTS ${tables.app_settings} (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- Business settings table
    CREATE TABLE IF NOT EXISTS ${tables.business_settings} (
      key         TEXT PRIMARY KEY,
      value       TEXT,
      description TEXT,
      updated_at  TEXT DEFAULT (datetime('now'))
    );

    -- Customer metrics table
    CREATE TABLE IF NOT EXISTS ${tables.customer_metrics} (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      phone           TEXT NOT NULL,
      name            TEXT,
      email           TEXT,
      total_bookings  INTEGER DEFAULT 0,
      completed       INTEGER DEFAULT 0,
      no_shows        INTEGER DEFAULT 0,
      cancellations   INTEGER DEFAULT 0,
      reschedules     INTEGER DEFAULT 0,
      total_spent     INTEGER DEFAULT 0,
      preferred_branch TEXT,
      preferred_staff  TEXT,
      loyalty_points   INTEGER DEFAULT 0,
      notes           TEXT,
      last_visit      TEXT,
      created_at      TEXT DEFAULT (datetime('now')),
      updated_at      TEXT DEFAULT (datetime('now')),
      UNIQUE(phone)
    );

    -- Booking audit table
    CREATE TABLE IF NOT EXISTS ${tables.booking_audit} (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      booking_id  INTEGER NOT NULL REFERENCES ${tables.bookings}(id) ON DELETE CASCADE,
      old_status  TEXT,
      new_status  TEXT,
      changed_by  TEXT,
      reason      TEXT,
      ip_address  TEXT,
      user_agent  TEXT,
      changed_at  TEXT DEFAULT (datetime('now'))
    );

    -- Booking reschedules table
    CREATE TABLE IF NOT EXISTS ${tables.booking_reschedules} (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      original_booking_id INTEGER NOT NULL REFERENCES ${tables.bookings}(id),
      new_booking_id      INTEGER NOT NULL REFERENCES ${tables.bookings}(id),
      old_date            TEXT,
      old_time            TEXT,
      new_date            TEXT,
      new_time            TEXT,
      reason              TEXT,
      rescheduled_at      TEXT DEFAULT (datetime('now'))
    );

    -- Notification logs table
    CREATE TABLE IF NOT EXISTS ${tables.notification_logs} (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      recipient   TEXT NOT NULL,
      type        TEXT NOT NULL,
      booking_id  INTEGER REFERENCES ${tables.bookings}(id),
      status      TEXT,
      error       TEXT,
      sent_at     TEXT DEFAULT (datetime('now'))
    );

    -- Staff bookings table
    CREATE TABLE IF NOT EXISTS ${tables.staff_bookings} (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      staffId   INTEGER NOT NULL REFERENCES ${tables.staff}(id) ON DELETE CASCADE,
      bookingId INTEGER NOT NULL REFERENCES ${tables.bookings}(id) ON DELETE CASCADE,
      branchId  INTEGER REFERENCES ${tables.branches}(id) ON DELETE SET NULL,
      startTime TEXT    NOT NULL,
      endTime   TEXT    NOT NULL,
      status    TEXT    NOT NULL DEFAULT 'active',
      created_at TEXT   DEFAULT (datetime('now')),
      updated_at TEXT   DEFAULT (datetime('now')),
      UNIQUE(staffId, bookingId)
    );
  `);

  // Seed default data for the tenant
  seedTenantTables(tenantId, tables);
  console.log(`✅ Created ALL tables for tenant ${tenantId}`);
}

function seedTenantTables(tenantId, tables) {
  const db = getDb();

  // Seed staff roles with ALL required roles
  const roleCount = db.prepare(`SELECT COUNT(*) as c FROM ${tables.staff_roles}`).get().c;
  if (roleCount === 0) {
    const insRole = db.prepare(`INSERT INTO ${tables.staff_roles} (name) VALUES (?)`);
    const allRoles = [
      'stylist',
      'receptionist',
      'manager',
      'admin',
      'beautician',
      'therapist',
      'makeup artist',
      'hair stylist',
      'nail technician',
      'spa therapist'
    ];
    for (const role of allRoles) {
      try {
        insRole.run(role);
      } catch (e) {
        // Role might already exist
        if (!e.message.includes('UNIQUE')) console.error(`Error seeding role ${role}:`, e.message);
      }
    }
    console.log(`  ✅ Seeded ${allRoles.length} staff roles for ${tenantId}`);
  } else {
    // Ensure all required roles exist even if table wasn't empty
    const existingRoles = db.prepare(`SELECT name FROM ${tables.staff_roles}`).all().map(r => r.name);
    const requiredRoles = [
      'stylist', 'receptionist', 'manager', 'admin', 'beautician',
      'therapist', 'makeup artist', 'hair stylist', 'nail technician', 'spa therapist'
    ];
    const missingRoles = requiredRoles.filter(r => !existingRoles.includes(r));

    if (missingRoles.length > 0) {
      const insRole = db.prepare(`INSERT INTO ${tables.staff_roles} (name) VALUES (?)`);
      for (const role of missingRoles) {
        try {
          insRole.run(role);
          console.log(`  ✅ Added missing role: ${role}`);
        } catch (e) {
          // Ignore duplicate errors
        }
      }
    }
  }

  // Seed salon timings
  const timingCount = db.prepare(`SELECT COUNT(*) as c FROM ${tables.salon_timings}`).get().c;
  if (timingCount === 0) {
    const ins = db.prepare(
      `INSERT INTO ${tables.salon_timings} (day_type, open_time, close_time) VALUES (?, ?, ?)`
    );
    ins.run('workday', '09:00', '21:00');
    ins.run('weekend', '10:00', '20:00');
    console.log(`  ✅ Seeded salon timings for ${tenantId}`);
  }

  // Seed branches
  const branchCount = db.prepare(`SELECT COUNT(*) as c FROM ${tables.branches}`).get().c;
  if (branchCount === 0) {
    const insert = db.prepare(
      `INSERT INTO ${tables.branches} (number, name, address, map_link, phone) VALUES (?, ?, ?, ?, ?)`
    );

    // Create 2 default branches
    const branches = [
      [1, 'Gulberg Branch', '123 Main Street, Gulberg, Lahore', 'https://maps.google.com/?q=Gulberg+Branch', '+92 300 1234567'],
      [2, 'DHA Branch', '456 Park Avenue, DHA, Lahore', 'https://maps.google.com/?q=DHA+Branch', '+92 300 7654321']
    ];

    for (const [number, name, address, mapLink, phone] of branches) {
      insert.run(number, name, address, mapLink, phone);
    }
    console.log(`  ✅ Seeded branches for ${tenantId}`);
  }

  // Seed staff only if branches exist and no staff
  const staffCount = db.prepare(`SELECT COUNT(*) as c FROM ${tables.staff}`).get().c;
  if (staffCount === 0) {
    const branchesList = db.prepare(`SELECT id, name FROM ${tables.branches} ORDER BY id`).all();
    if (branchesList.length > 0) {
      const insertStaff = db.prepare(
        `INSERT INTO ${tables.staff} (name, phone, role, branch_id, status, requestedCount) VALUES (?, ?, ?, ?, ?, 0)`
      );

      insertStaff.run('Sara Ahmed', '03001234567', 'stylist', branchesList[0].id, 'active');
      insertStaff.run('Nadia Malik', '03011234567', 'stylist', branchesList[0].id, 'active');
      insertStaff.run('Aisha Khan', '03021234567', 'receptionist', branchesList[0].id, 'active');
      insertStaff.run('Fatima Ali', '03031234567', 'stylist', branchesList.length > 1 ? branchesList[1].id : branchesList[0].id, 'active');
      insertStaff.run('Zainab Riaz', '03041234567', 'manager', branchesList[0].id, 'active');
      insertStaff.run('Meera Sheikh', '03051234567', 'beautician', branchesList.length > 1 ? branchesList[1].id : branchesList[0].id, 'active');

      console.log(`  ✅ Seeded ${6} sample staff for ${tenantId}`);
    }
  }

  // Seed default business settings
  const businessCount = db.prepare(`SELECT COUNT(*) as c FROM ${tables.business_settings}`).get().c;
  if (businessCount === 0) {
    const bizStmt = db.prepare(`
      INSERT INTO ${tables.business_settings} (key, value, description)
      VALUES (?, ?, ?)
    `);
    bizStmt.run('cancellation_hours', '24', 'Hours before appointment to cancel without fee');
    bizStmt.run('no_show_grace_minutes', '30', 'Minutes after appointment to mark as no-show');
    bizStmt.run('deposit_percentage', '0', 'Percentage deposit required for booking');
    bizStmt.run('reminder_hours', '24', 'Hours before to send reminder');
    bizStmt.run('max_reschedules', '2', 'Maximum times a booking can be rescheduled');
    console.log(`  ✅ Seeded business settings for ${tenantId}`);
  }

  // Seed default app settings
  const settingsCount = db.prepare(`SELECT COUNT(*) as c FROM ${tables.app_settings}`).get().c;
  if (settingsCount === 0) {
    const settingsStmt = db.prepare(`
      INSERT INTO ${tables.app_settings} (key, value)
      VALUES (?, ?)
    `);
    settingsStmt.run('currency', 'Rs.');
    settingsStmt.run('salon_name', `Salon ${tenantId}`);
    settingsStmt.run('timezone', 'Asia/Karachi');
    console.log(`  ✅ Seeded app settings for ${tenantId}`);
  }
}

// Initialize all tenants from super.db
async function initializeAllTenants() {
  console.log('🚀 Initializing all tenants from super.db...');

  try {
    // Check if super.db exists
    const fs = require('fs');
    if (!fs.existsSync(SUPER_DB_PATH)) {
      console.log('⚠️ super.db not found. No tenants to initialize.');
      return;
    }

    const superDb = new Database(SUPER_DB_PATH);

    // Check if salon_tenants table exists
    const tableCheck = superDb.prepare(`
      SELECT name FROM sqlite_master 
      WHERE type='table' AND name='salon_tenants'
    `).get();

    if (!tableCheck) {
      console.log('⚠️ salon_tenants table not found in super.db. No tenants to initialize.');
      superDb.close();
      return;
    }

    // Get all active tenants
    const tenants = superDb.prepare(`
      SELECT tenant_id FROM salon_tenants WHERE status = 'active'
    `).all();

    superDb.close();

    if (tenants.length === 0) {
      console.log('ℹ️ No active tenants found in super.db');
      return;
    }

    console.log(`📋 Found ${tenants.length} tenant(s) in super.db: ${tenants.map(t => t.tenant_id).join(', ')}`);

    // Create tables for each tenant if they don't exist
    for (const tenant of tenants) {
      const tenantId = tenant.tenant_id;
      ensureTenantTables(tenantId);
    }

    console.log('✅ All tenants initialized successfully');
  } catch (error) {
    console.error('❌ Error initializing tenants:', error);
  }
}

// Tenant management
let currentTenantId = null;

function setCurrentTenant(tenantId) {
  currentTenantId = tenantId;
  if (tenantId) {
    ensureTenantTables(tenantId);
  }
}

function getCurrentTenant() {
  return currentTenantId;
}

function getTenantTableName(tenantId, baseTableName) {
  return `${tenantId}_${baseTableName}`;
}

function ensureTenantTables(tenantId) {
  if (!tenantId) return;

  const dbInstance = getDb();
  try {
    const checkTable = dbInstance.prepare(`
      SELECT name FROM sqlite_master 
      WHERE type='table' AND name=?
    `);
    const tableExists = checkTable.get(`${tenantId}_branches`);

    if (!tableExists) {
      console.log(`📦 Creating tables for tenant ${tenantId}...`);
      createTenantTables(tenantId);
    } else {
      console.log(`✅ Tables for tenant ${tenantId} already exist`);
    }
  } catch (error) {
    console.error(`Error ensuring tenant tables for ${tenantId}:`, error);
    createTenantTables(tenantId);
  }
}

function initializeTenant(tenantId) {
  console.log(`🚀 Initializing new tenant: ${tenantId}`);
  ensureTenantTables(tenantId);
  invalidateSettingsCache();
  console.log(`✅ Tenant ${tenantId} initialized successfully`);
}

// Delete all tables for a tenant (useful for resetting)
function dropTenantTables(tenantId) {
  const db = getDb();
  console.log(`⚠️ Dropping ALL tables for tenant ${tenantId}...`);

  const tables = [
    `${tenantId}_deals`,
    `${tenantId}_services`,
    `${tenantId}_staff_roles`,
    `${tenantId}_salon_timings`,
    `${tenantId}_bookings`,
    `${tenantId}_branches`,
    `${tenantId}_staff`,
    `${tenantId}_app_settings`,
    `${tenantId}_business_settings`,
    `${tenantId}_customer_metrics`,
    `${tenantId}_booking_audit`,
    `${tenantId}_booking_reschedules`,
    `${tenantId}_notification_logs`,
    `${tenantId}_staff_bookings`
  ];

  for (const table of tables) {
    try {
      db.exec(`DROP TABLE IF EXISTS ${table}`);
    } catch (error) {
      // Ignore errors
    }
  }

  console.log(`✅ Dropped all tables for tenant ${tenantId}`);
}

module.exports = {
  getCurrentTenant,
  setCurrentTenant,
  getTenantTableName,
  getDb,
  getSettings,
  invalidateSettingsCache,
  ensureTenantTables,
  initializeTenant,
  createTenantTables,
  dropTenantTables,
  initializeAllTenants  // Export this function
};