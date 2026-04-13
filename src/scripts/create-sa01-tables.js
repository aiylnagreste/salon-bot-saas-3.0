// scripts/create-sa01-tables.js
const { getDb } = require('../db/database');

function createTenantTables(tenantId) {
    const db = getDb();

    console.log(`Creating tables for ${tenantId}...`);

    // 1. Staff Roles
    db.exec(`
        CREATE TABLE IF NOT EXISTS ${tenantId}_staff_roles (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    const defaultRoles = ['admin', 'manager', 'receptionist', 'stylist', 'beautician', 'therapist', 'makeup artist', 'nail technician'];
    const insertRole = db.prepare(`INSERT OR IGNORE INTO ${tenantId}_staff_roles (name) VALUES (?)`);
    defaultRoles.forEach(role => {
        insertRole.run(role);
    });

    // 2. Branches
    db.exec(`
        CREATE TABLE IF NOT EXISTS ${tenantId}_branches (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            number INTEGER UNIQUE NOT NULL,
            name TEXT NOT NULL,
            address TEXT NOT NULL,
            map_link TEXT NOT NULL,
            phone TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // 3. Staff
    db.exec(`
        CREATE TABLE IF NOT EXISTS ${tenantId}_staff (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            phone TEXT NOT NULL,
            role TEXT NOT NULL,
            branch_id INTEGER,
            status TEXT DEFAULT 'active',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (branch_id) REFERENCES ${tenantId}_branches(id)
        )
    `);

    // 4. Services
    db.exec(`
        CREATE TABLE IF NOT EXISTS ${tenantId}_services (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            price TEXT NOT NULL,
            description TEXT,
            branch TEXT NOT NULL,
            durationMinutes INTEGER DEFAULT 60,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // 5. Bookings
    db.exec(`
        CREATE TABLE IF NOT EXISTS ${tenantId}_bookings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            customer_name TEXT NOT NULL,
            phone TEXT NOT NULL,
            service TEXT NOT NULL,
            branch TEXT NOT NULL,
            date TEXT NOT NULL,
            time TEXT NOT NULL,
            endTime TEXT,
            notes TEXT,
            status TEXT DEFAULT 'confirmed',
            source TEXT DEFAULT 'web',
            staff_id INTEGER,
            staff_name TEXT,
            staffRequested INTEGER DEFAULT 0,
            reminder_sent INTEGER DEFAULT 0,
            cancellation_reason TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (staff_id) REFERENCES ${tenantId}_staff(id)
        )
    `);

    // 6. Deals
    db.exec(`
        CREATE TABLE IF NOT EXISTS ${tenantId}_deals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            description TEXT,
            active INTEGER DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // 7. Salon Timings
    db.exec(`
        CREATE TABLE IF NOT EXISTS ${tenantId}_salon_timings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            day_type TEXT UNIQUE NOT NULL,
            open_time TEXT NOT NULL,
            close_time TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    const insertTiming = db.prepare(`INSERT OR IGNORE INTO ${tenantId}_salon_timings (day_type, open_time, close_time) VALUES (?, ?, ?)`);
    insertTiming.run('workday', '09:00', '21:00');
    insertTiming.run('weekend', '10:00', '18:00');

    // 8. Staff Bookings
    db.exec(`
        CREATE TABLE IF NOT EXISTS ${tenantId}_staff_bookings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            staffId INTEGER NOT NULL,
            bookingId INTEGER NOT NULL,
            branchId INTEGER,
            startTime TEXT,
            endTime TEXT,
            status TEXT DEFAULT 'active',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (staffId) REFERENCES ${tenantId}_staff(id),
            FOREIGN KEY (bookingId) REFERENCES ${tenantId}_bookings(id),
            FOREIGN KEY (branchId) REFERENCES ${tenantId}_branches(id)
        )
    `);

    // 9. Customer Metrics
    db.exec(`
        CREATE TABLE IF NOT EXISTS ${tenantId}_customer_metrics (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            phone TEXT UNIQUE NOT NULL,
            name TEXT,
            total_bookings INTEGER DEFAULT 0,
            completed INTEGER DEFAULT 0,
            no_shows INTEGER DEFAULT 0,
            cancellations INTEGER DEFAULT 0,
            total_spent REAL DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // 10. Booking Audit
    db.exec(`
        CREATE TABLE IF NOT EXISTS ${tenantId}_booking_audit (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            booking_id INTEGER NOT NULL,
            old_status TEXT,
            new_status TEXT NOT NULL,
            changed_by TEXT,
            reason TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (booking_id) REFERENCES ${tenantId}_bookings(id)
        )
    `);

    // 11. App Settings
    db.exec(`
        CREATE TABLE IF NOT EXISTS ${tenantId}_app_settings (
            key TEXT PRIMARY KEY,
            value TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    const insertSetting = db.prepare(`INSERT OR IGNORE INTO ${tenantId}_app_settings (key, value) VALUES (?, ?)`);
    insertSetting.run('currency', 'Rs.');

    // 12. Business Settings
    db.exec(`
        CREATE TABLE IF NOT EXISTS ${tenantId}_business_settings (
            key TEXT PRIMARY KEY,
            value TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    insertSetting.run('reminder_hours', '24');
    insertSetting.run('cancellation_hours', '24');

    // Insert sample branch
    const insertBranch = db.prepare(`INSERT INTO ${tenantId}_branches (number, name, address, map_link, phone) VALUES (?, ?, ?, ?, ?)`);
    insertBranch.run(1, 'Main Branch', '123 Main Street, City', 'https://maps.google.com/?q=123+Main+Street', '+1234567890');

    // Insert sample staff
    const insertStaff = db.prepare(`INSERT INTO ${tenantId}_staff (name, phone, role, branch_id, status) VALUES (?, ?, ?, ?, ?)`);
    insertStaff.run('Admin User', '+1234567890', 'admin', 1, 'active');

    // Insert sample services
    const insertService = db.prepare(`INSERT INTO ${tenantId}_services (name, price, description, branch, durationMinutes) VALUES (?, ?, ?, ?, ?)`);
    const sampleServices = [
        ['Haircut', '1500', 'Professional haircut and styling', 'Main Branch', 30],
        ['Hair Color', '3500', 'Full hair color with premium products', 'Main Branch', 90],
        ['Manicure', '1200', 'Classic manicure with nail shaping', 'Main Branch', 45],
        ['Pedicure', '1500', 'Relaxing pedicure treatment', 'Main Branch', 45],
        ['Facial', '2500', 'Deep cleansing facial', 'Main Branch', 60]
    ];
    sampleServices.forEach(service => {
        insertService.run(service[0], service[1], service[2], service[3], service[4]);
    });

    // Insert sample deals
    const insertDeal = db.prepare(`INSERT INTO ${tenantId}_deals (title, description, active) VALUES (?, ?, ?)`);
    insertDeal.run('Welcome Discount', '20% off on first visit', 1);
    insertDeal.run('Summer Special', 'Buy 2 services get 1 free', 1);

    console.log(`✅ Tables created for ${tenantId}`);
}

// Create tables for SA_01
try {
    createTenantTables('SA_01');
    console.log('\n✅ SA_01 tables created successfully!');
} catch (error) {
    console.error('❌ Error creating SA_01 tables:', error.message);
}