const bcrypt = require('bcrypt');
const Database = require('better-sqlite3');
const path = require('path');

const SUPER_DB_PATH = './super.db';

async function fixAuth() {
    console.log('🔧 Fixing authentication...\n');

    const db = new Database(SUPER_DB_PATH);

    // Create tables if not exist
    db.exec(`
        CREATE TABLE IF NOT EXISTS super_admin (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            email TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now'))
        )
    `);

    db.exec(`
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

    // Create super admin - FIXED: Let AUTOINCREMENT handle the ID
    const superPassword = 'admin123';
    const superHash = bcrypt.hashSync(superPassword, 10);

    const existingSuper = db.prepare('SELECT * FROM super_admin WHERE username = ?').get('superadmin');
    if (existingSuper) {
        db.prepare('UPDATE super_admin SET password_hash = ?, email = ? WHERE username = ?')
            .run(superHash, 'super@salon.com', 'superadmin');
        console.log('✅ Updated super admin');
    } else {
        // Don't specify ID - let AUTOINCREMENT handle it
        db.prepare('INSERT INTO super_admin (username, password_hash, email) VALUES (?, ?, ?)')
            .run('superadmin', superHash, 'super@salon.com');
        console.log('✅ Created super admin');
    }

    // Create default tenant - FIXED: Check by tenant_id and email
    const tenantPassword = 'default123';
    const tenantHash = bcrypt.hashSync(tenantPassword, 10);

    const existingTenant = db.prepare('SELECT * FROM salon_tenants WHERE email = ? OR tenant_id = ?')
        .get('admin@default.com', 'SA_01');

    if (existingTenant) {
        db.prepare('UPDATE salon_tenants SET password_hash = ?, phone = ? WHERE email = ?')
            .run(tenantHash, '1234567890', 'admin@default.com');
        console.log('✅ Updated tenant');
    } else {
        db.prepare(`
            INSERT INTO salon_tenants (tenant_id, owner_name, salon_name, email, phone, password_hash, status)
            VALUES (?, ?, ?, ?, ?, ?, 'active')
        `).run('SA_01', 'Default Owner', 'Default Salon', 'admin@default.com', '1234567890', tenantHash);
        console.log('✅ Created default tenant');
    }

    // Verify
    console.log('\n🔐 Verification:');
    const verifySuper = db.prepare('SELECT * FROM super_admin WHERE username = ?').get('superadmin');
    const verifyTenant = db.prepare('SELECT * FROM salon_tenants WHERE email = ?').get('admin@default.com');

    console.log(`Super Admin: ${verifySuper ? '✅ Exists' : '❌ Missing'}`);
    console.log(`Tenant: ${verifyTenant ? '✅ Exists' : '❌ Missing'}`);

    if (verifySuper) {
        console.log(`  ID: ${verifySuper.id}`);
        console.log(`  Username: ${verifySuper.username}`);
    }

    if (verifyTenant) {
        console.log(`  Tenant ID: ${verifyTenant.tenant_id}`);
        console.log(`  Salon: ${verifyTenant.salon_name}`);
    }

    console.log('\n📋 Credentials:');
    console.log('Super Admin:');
    console.log('  Username: superadmin');
    console.log('  Password: admin123');
    console.log('\nSalon Admin:');
    console.log('  Email: admin@default.com');
    console.log('  Password: default123');

    db.close();
}

fixAuth().catch(console.error);