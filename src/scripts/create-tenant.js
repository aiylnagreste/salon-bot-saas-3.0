const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const path = require('path');

// Import your database module
const { initializeTenant } = require('../database');

const SUPER_DB_PATH = './super.db';

async function createNewTenant(tenantData) {
    const {
        tenantId,
        ownerName,
        salonName,
        email,
        phone,
        password
    } = tenantData;

    console.log(`Creating new tenant: ${tenantId}`);

    const superDb = new Database(SUPER_DB_PATH);

    try {
        // Check if tenant already exists
        const existing = superDb.prepare('SELECT * FROM salon_tenants WHERE tenant_id = ? OR email = ?')
            .get(tenantId, email);

        if (existing) {
            throw new Error(`Tenant with ID ${tenantId} or email ${email} already exists`);
        }

        // Hash password
        const passwordHash = bcrypt.hashSync(password, 10);

        // Insert into super.db
        const insert = superDb.prepare(`
      INSERT INTO salon_tenants (
        tenant_id, owner_name, salon_name, email, phone, 
        password_hash, status, subscription_plan, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'active', 'basic', datetime('now'))
    `);

        insert.run(tenantId, ownerName, salonName, email, phone, passwordHash);

        // Create all tenant-specific tables in salon.db
        console.log(`Creating database tables for ${tenantId}...`);
        initializeTenant(tenantId);

        console.log(`✅ Tenant ${tenantId} created successfully!`);
        console.log(`📋 Tenant credentials:`);
        console.log(`   Tenant ID: ${tenantId}`);
        console.log(`   Email: ${email}`);
        console.log(`   Password: ${password}`);

        return { success: true, tenantId };
    } catch (error) {
        console.error(`Failed to create tenant:`, error);
        throw error;
    } finally {
        superDb.close();
    }
}

// Example usage
if (require.main === module) {
    // Create SA_02 tenant
    createNewTenant({
        tenantId: 'SA_02',
        ownerName: 'Second Owner',
        salonName: 'Second Salon',
        email: 'admin@salon2.com',
        phone: '0987654321',
        password: 'salon123'
    }).catch(console.error);
}

module.exports = { createNewTenant };