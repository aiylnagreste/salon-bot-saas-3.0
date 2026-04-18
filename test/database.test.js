'use strict';
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// Mock the database module
let databaseModule;
let testDbPath;

describe('Database Module', () => {
    let originalEnv;
    let mockDb;

    before(() => {
        originalEnv = { ...process.env };
        // Create a temporary test database
        testDbPath = path.join(__dirname, 'test_salon.db');
        if (fs.existsSync(testDbPath)) {
            fs.unlinkSync(testDbPath);
        }
        process.env.DB_PATH = testDbPath;
        process.env.SUPER_DB_PATH = path.join(__dirname, 'test_super.db');

        // Clear require cache to reload module with test paths
        delete require.cache[require.resolve('../src/db/database')];
        databaseModule = require('../src/db/database');
    });

    after(() => {
        // Cleanup
        if (fs.existsSync(testDbPath)) {
            fs.unlinkSync(testDbPath);
        }
        if (fs.existsSync(process.env.SUPER_DB_PATH)) {
            fs.unlinkSync(process.env.SUPER_DB_PATH);
        }
        process.env.DB_PATH = originalEnv.DB_PATH;
        process.env.SUPER_DB_PATH = originalEnv.SUPER_DB_PATH;
    });

    describe('getDb()', () => {
        test('returns a database instance', () => {
            const db = databaseModule.getDb();
            assert.ok(db);
            assert.equal(db.name, testDbPath);
        });

        test('returns same instance on multiple calls', () => {
            const db1 = databaseModule.getDb();
            const db2 = databaseModule.getDb();
            assert.strictEqual(db1, db2);
        });
    });

    describe('createTenantTables()', () => {
        test('creates all tables for a tenant', () => {
            const tenantId = 'TEST_01';
            databaseModule.createTenantTables(tenantId);

            const db = databaseModule.getDb();

            // Verify key tables were created
            const tables = [
                `${tenantId}_deals`,
                `${tenantId}_services`,
                `${tenantId}_staff_roles`,
                `${tenantId}_salon_timings`,
                `${tenantId}_bookings`,
                `${tenantId}_branches`,
                `${tenantId}_staff`,
                `${tenantId}_app_settings`,
                `${tenantId}_business_settings`
            ];

            for (const table of tables) {
                const result = db.prepare(`
                    SELECT name FROM sqlite_master 
                    WHERE type='table' AND name=?
                `).get(table);
                assert.ok(result, `Table ${table} should exist`);
            }
        });

        test('does not recreate existing tables', () => {
            const tenantId = 'TEST_02';
            databaseModule.createTenantTables(tenantId);

            const db = databaseModule.getDb();

            // Insert test data
            db.prepare(`INSERT INTO ${tenantId}_branches (number, name, address, map_link, phone) 
                       VALUES (1, 'Test Branch', '123 Test St', 'http://map.com', '1234567890')`).run();

            // Call createTenantTables again
            databaseModule.createTenantTables(tenantId);

            // Verify data still exists
            const branch = db.prepare(`SELECT * FROM ${tenantId}_branches WHERE number = 1`).get();
            assert.ok(branch);
            assert.equal(branch.name, 'Test Branch');
        });
    });

    describe('seedTenantTables()', () => {
        test('seeds default data for tenant tables', () => {
            const tenantId = 'TEST_03';
            databaseModule.createTenantTables(tenantId);

            const db = databaseModule.getDb();

            // Check staff roles were seeded
            const roles = db.prepare(`SELECT name FROM ${tenantId}_staff_roles`).all();
            assert.ok(roles.length >= 5);

            // Check salon timings were seeded
            const timings = db.prepare(`SELECT * FROM ${tenantId}_salon_timings`).all();
            assert.equal(timings.length, 2);

            // Check branches were seeded
            const branches = db.prepare(`SELECT * FROM ${tenantId}_branches`).all();
            assert.ok(branches.length >= 2);

            // Check staff were seeded
            const staff = db.prepare(`SELECT * FROM ${tenantId}_staff`).all();
            assert.ok(staff.length >= 5);

            // Check business settings
            const settings = db.prepare(`SELECT * FROM ${tenantId}_business_settings`).all();
            assert.ok(settings.length >= 5);
        });
    });

    describe('getSettings()', () => {
        let tenantId;

        before(() => {
            tenantId = 'TEST_04';
            databaseModule.createTenantTables(tenantId);
            databaseModule.setCurrentTenant(tenantId);

            const db = databaseModule.getDb();
            // Insert test settings
            db.prepare(`INSERT INTO ${tenantId}_app_settings (key, value) VALUES (?, ?)`)
                .run('test_key', 'test_value');
            db.prepare(`INSERT INTO ${tenantId}_app_settings (key, value) VALUES (?, ?)`)
                .run('another_key', 'another_value');
        });

        test('returns settings for current tenant', () => {
            const settings = databaseModule.getSettings();
            assert.equal(settings.test_key, 'test_value');
            assert.equal(settings.another_key, 'another_value');
        });

        test('returns empty object for tenant with no settings', () => {
            const settings = databaseModule.getSettings('NON_EXISTENT');
            assert.deepEqual(settings, {});
        });

        test('caches settings after first fetch', () => {
            // First fetch
            const settings1 = databaseModule.getSettings(tenantId);

            // Modify database directly
            const db = databaseModule.getDb();
            db.prepare(`UPDATE ${tenantId}_app_settings SET value = ? WHERE key = ?`)
                .run('changed_value', 'test_key');

            // Second fetch should still return cached value
            const settings2 = databaseModule.getSettings(tenantId);
            assert.equal(settings2.test_key, 'test_value'); // Still old cached value
        });
    });

    describe('invalidateSettingsCache()', () => {
        test('clears settings cache', () => {
            const tenantId = 'TEST_05';
            databaseModule.createTenantTables(tenantId);

            // First fetch
            const settings1 = databaseModule.getSettings(tenantId);

            // Invalidate cache
            databaseModule.invalidateSettingsCache();

            // Now should fetch fresh from DB
            const settings2 = databaseModule.getSettings(tenantId);
            assert.ok(settings2);
        });
    });

    describe('setCurrentTenant() / getCurrentTenant()', () => {
        test('sets and gets current tenant', () => {
            const tenantId = 'TEST_06';
            databaseModule.setCurrentTenant(tenantId);
            assert.equal(databaseModule.getCurrentTenant(), tenantId);
        });

        test('creates tables when setting new tenant', () => {
            const tenantId = 'TEST_07';
            databaseModule.setCurrentTenant(tenantId);

            const db = databaseModule.getDb();
            const tableExists = db.prepare(`
                SELECT name FROM sqlite_master 
                WHERE type='table' AND name=?
            `).get(`${tenantId}_branches`);

            assert.ok(tableExists);
        });
    });

    describe('getTenantTableName()', () => {
        test('returns prefixed table name', () => {
            const result = databaseModule.getTenantTableName('TENANT_01', 'bookings');
            assert.equal(result, 'TENANT_01_bookings');
        });
    });

    describe('ensureTenantTables()', () => {
        test('creates tables if they do not exist', () => {
            const tenantId = 'TEST_08';
            databaseModule.ensureTenantTables(tenantId);

            const db = databaseModule.getDb();
            const tableExists = db.prepare(`
                SELECT name FROM sqlite_master 
                WHERE type='table' AND name=?
            `).get(`${tenantId}_branches`);

            assert.ok(tableExists);
        });

        test('does nothing if tables already exist', () => {
            const tenantId = 'TEST_09';
            databaseModule.ensureTenantTables(tenantId);

            // Should not throw error on second call
            assert.doesNotThrow(() => {
                databaseModule.ensureTenantTables(tenantId);
            });
        });
    });

    describe('initializeTenant()', () => {
        test('initializes tenant with tables and cache invalidation', () => {
            const tenantId = 'TEST_10';
            databaseModule.initializeTenant(tenantId);

            const db = databaseModule.getDb();
            const tableExists = db.prepare(`
                SELECT name FROM sqlite_master 
                WHERE type='table' AND name=?
            `).get(`${tenantId}_branches`);

            assert.ok(tableExists);
        });
    });

    describe('dropTenantTables()', () => {
        test('drops all tables for a tenant', () => {
            const tenantId = 'TEST_11';
            databaseModule.createTenantTables(tenantId);

            const db = databaseModule.getDb();

            // Verify tables exist
            let tableExists = db.prepare(`
                SELECT name FROM sqlite_master 
                WHERE type='table' AND name=?
            `).get(`${tenantId}_branches`);
            assert.ok(tableExists);

            // Drop tables
            databaseModule.dropTenantTables(tenantId);

            // Verify tables are gone
            tableExists = db.prepare(`
                SELECT name FROM sqlite_master 
                WHERE type='table' AND name=?
            `).get(`${tenantId}_branches`);
            assert.ok(!tableExists);
        });

        test('handles dropping non-existent tables gracefully', () => {
            assert.doesNotThrow(() => {
                databaseModule.dropTenantTables('NON_EXISTENT_TENANT');
            });
        });
    });
});