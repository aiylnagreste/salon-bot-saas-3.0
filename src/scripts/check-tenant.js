// scripts/check-tenant.js
const { getSuperDb } = require('../db/database');

const superDb = getSuperDb();
const tenant = superDb.prepare('SELECT * FROM tenants WHERE tenant_id = ?').get('SA_01');

if (tenant) {
    console.log('SA_01 exists:', tenant);
} else {
    console.log('SA_01 not found in tenants table');

    // List all tenants
    const allTenants = superDb.prepare('SELECT * FROM tenants').all();
    console.log('\nAll tenants:', allTenants);
}