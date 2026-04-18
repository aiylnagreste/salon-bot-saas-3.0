'use strict';
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');

// Mock the database module
let tenantManager;
let testSuperDbPath;
let testSalonDbPath;

describe('Tenant Manager', () => {
    let originalEnv;

    before(() => {
        originalEnv = { ...process.env };

        // Create temporary database paths
        testSuperDbPath = path.join(__dirname, 'test_super.db');
        testSalonDbPath = path.join(__dirname, 'test_salon.db');

        if (fs.existsSync(testSuperDbPath)) fs.unlinkSync(testSuperDbPath);
        if (fs.existsSync(testSalonDbPath)) fs.unlinkSync(testSalonDbPath);

        process.env.SUPER_DB_PATH = testSuperDbPath;
        process.env.DB_PATH = testSalonDbPath;

        // Clear require cache
        delete require.cache[require.resolve('../src/db/tenantManager')];
        delete require.cache[require.resolve('../src/db/database')];

        tenantManager = require('../src/db/tenantManager');
    });

    after(() => {
        // Cleanup
        if (fs.existsSync(testSuperDbPath)) fs.unlinkSync(testSuperDbPath);
        if (fs.existsSync(testSalonDbPath)) fs.unlinkSync(testSalonDbPath);
        process.env.DB_PATH = originalEnv.DB_PATH;
        process.env.SUPER_DB_PATH = originalEnv.SUPER_DB_PATH;
    });

    describe('getSuperDb()', () => {
        test('creates super database connection', () => {
            const db = tenantManager.getSuperDb();
            assert.ok(db);
            assert.equal(db.name, testSuperDbPath);
        });

        test('initializes super schema on first connection', () => {
            const db = tenantManager.getSuperDb();

            // Check if tables were created
            const tables = ['salon_tenants', 'super_admin', 'tenant_settings',
                'tenant_webhook_configs', 'plans', 'subscriptions'];

            for (const table of tables) {
                const result = db.prepare(`
                    SELECT name FROM sqlite_master 
                    WHERE type='table' AND name=?
                `).get(table);
                assert.ok(result, `Table ${table} should exist`);
            }
        });
    });

    describe('createTenant()', () => {
        test('creates a new tenant with unique ID', async () => {
            const tenantId = await tenantManager.createTenant(
                'Test Owner',
                'Test Salon',
                'test@salon.com',
                '1234567890',
                'password123'
            );

            assert.ok(tenantId);
            assert.match(tenantId, /^SA_\d{2}$/);

            // Verify tenant was saved
            const tenant = tenantManager.getTenantById(tenantId);
            assert.ok(tenant);
            assert.equal(tenant.owner_name, 'Test Owner');
            assert.equal(tenant.salon_name, 'Test Salon');
            assert.equal(tenant.email, 'test@salon.com');
        });

        test('generates sequential tenant IDs', async () => {
            const tenantId1 = await tenantManager.createTenant(
                'Owner 1', 'Salon 1', 'owner1@test.com', '1111111111', 'pass1'
            );
            const tenantId2 = await tenantManager.createTenant(
                'Owner 2', 'Salon 2', 'owner2@test.com', '2222222222', 'pass2'
            );

            const num1 = parseInt(tenantId1.split('_')[1]);
            const num2 = parseInt(tenantId2.split('_')[1]);
            assert.equal(num2, num1 + 1);
        });

        test('creates tenant tables in main database', async () => {
            const tenantId = await tenantManager.createTenant(
                'Table Test Owner',
                'Table Test Salon',
                'tables@test.com',
                '3333333333',
                'password'
            );

            const { getDb } = require('../src/db/database');
            const db = getDb();

            // Verify tables exist
            const tableExists = db.prepare(`
                SELECT name FROM sqlite_master 
                WHERE type='table' AND name=?
            `).get(`${tenantId}_branches`);

            assert.ok(tableExists);
        });
    });

    describe('authenticateTenant()', () => {
        let testTenantId;
        const testEmail = 'auth@test.com';
        const testPassword = 'securepass123';

        before(async () => {
            testTenantId = await tenantManager.createTenant(
                'Auth Owner',
                'Auth Salon',
                testEmail,
                '4444444444',
                testPassword
            );
        });

        test('authenticates with correct credentials', () => {
            const result = tenantManager.authenticateTenant(testEmail, testPassword);
            assert.ok(result);
            assert.equal(result.email, testEmail);
            assert.equal(result.tenant_id, testTenantId);
        });

        test('returns null for incorrect password', () => {
            const result = tenantManager.authenticateTenant(testEmail, 'wrongpassword');
            assert.equal(result, null);
        });

        test('returns null for non-existent email', () => {
            const result = tenantManager.authenticateTenant('nonexistent@test.com', 'password');
            assert.equal(result, null);
        });
    });

    describe('getTenantById() / getTenantByEmail()', () => {
        let createdTenantId;
        const testEmail = 'get@test.com';

        before(async () => {
            createdTenantId = await tenantManager.createTenant(
                'Get Owner',
                'Get Salon',
                testEmail,
                '5555555555',
                'password'
            );
        });

        test('getTenantById returns correct tenant', () => {
            const tenant = tenantManager.getTenantById(createdTenantId);
            assert.ok(tenant);
            assert.equal(tenant.tenant_id, createdTenantId);
            assert.equal(tenant.email, testEmail);
        });

        test('getTenantById returns undefined for non-existent', () => {
            const tenant = tenantManager.getTenantById('NON_EXISTENT');
            assert.equal(tenant, undefined);
        });

        test('getTenantByEmail returns correct tenant', () => {
            const tenant = tenantManager.getTenantByEmail(testEmail);
            assert.ok(tenant);
            assert.equal(tenant.email, testEmail);
        });
    });

    describe('updateTenantStatus()', () => {
        let tenantId;

        before(async () => {
            tenantId = await tenantManager.createTenant(
                'Status Owner',
                'Status Salon',
                'status@test.com',
                '6666666666',
                'password'
            );
        });

        test('updates tenant status', () => {
            tenantManager.updateTenantStatus(tenantId, 'inactive');
            const tenant = tenantManager.getTenantById(tenantId);
            assert.equal(tenant.status, 'inactive');

            tenantManager.updateTenantStatus(tenantId, 'active');
            const updatedTenant = tenantManager.getTenantById(tenantId);
            assert.equal(updatedTenant.status, 'active');
        });
    });

    describe('updateSalonName()', () => {
        let tenantId;

        before(async () => {
            tenantId = await tenantManager.createTenant(
                'Name Owner',
                'Original Name',
                'name@test.com',
                '7777777777',
                'password'
            );
        });

        test('updates salon name', () => {
            tenantManager.updateSalonName(tenantId, 'New Salon Name');
            const tenant = tenantManager.getTenantById(tenantId);
            assert.equal(tenant.salon_name, 'New Salon Name');
        });

        test('also updates tenant_settings for widget', () => {
            const setting = tenantManager.getTenantSetting(tenantId, 'salon_name');
            assert.equal(setting, 'New Salon Name');
        });
    });

    describe('Tenant Settings', () => {
        let tenantId;

        before(async () => {
            tenantId = await tenantManager.createTenant(
                'Settings Owner',
                'Settings Salon',
                'settings@test.com',
                '8888888888',
                'password'
            );
        });

        test('set and get tenant setting', () => {
            tenantManager.setTenantSetting(tenantId, 'test_key', 'test_value');
            const value = tenantManager.getTenantSetting(tenantId, 'test_key');
            assert.equal(value, 'test_value');
        });

        test('returns null for non-existent setting', () => {
            const value = tenantManager.getTenantSetting(tenantId, 'nonexistent');
            assert.equal(value, null);
        });

        test('updates existing setting', () => {
            tenantManager.setTenantSetting(tenantId, 'test_key', 'new_value');
            const value = tenantManager.getTenantSetting(tenantId, 'test_key');
            assert.equal(value, 'new_value');
        });
    });

    describe('isTenantActive()', () => {
        let activeTenantId;
        let inactiveTenantId;

        before(async () => {
            activeTenantId = await tenantManager.createTenant(
                'Active Owner',
                'Active Salon',
                'active@test.com',
                '9999999999',
                'password'
            );
            inactiveTenantId = await tenantManager.createTenant(
                'Inactive Owner',
                'Inactive Salon',
                'inactive@test.com',
                '1010101010',
                'password'
            );
            tenantManager.updateTenantStatus(inactiveTenantId, 'inactive');
        });

        test('returns true for active tenant', () => {
            const result = tenantManager.isTenantActive(activeTenantId);
            assert.equal(result, true);
        });

        test('returns false for inactive tenant', () => {
            const result = tenantManager.isTenantActive(inactiveTenantId);
            assert.equal(result, false);
        });

        test('returns false for non-existent tenant', () => {
            const result = tenantManager.isTenantActive('NON_EXISTENT');
            assert.equal(result, false);
        });
    });

    describe('Webhook Config', () => {
        let tenantId;

        before(async () => {
            tenantId = await tenantManager.createTenant(
                'Webhook Owner',
                'Webhook Salon',
                'webhook@test.com',
                '1111111111',
                'password'
            );
        });

        test('getWebhookConfig returns null when no config exists', () => {
            const config = tenantManager.getWebhookConfig(tenantId);
            assert.equal(config, null);
        });

        test('upsertWebhookConfig creates new config', () => {
            tenantManager.upsertWebhookConfig(tenantId, {
                wa_phone_number_id: '12345',
                wa_access_token: 'token123',
                wa_verify_token: 'verify123'
            });

            const config = tenantManager.getWebhookConfig(tenantId);
            assert.ok(config);
            assert.equal(config.wa_phone_number_id, '12345');
            assert.equal(config.wa_access_token, 'token123');
        });

        test('upsertWebhookConfig updates existing config', () => {
            tenantManager.upsertWebhookConfig(tenantId, {
                wa_phone_number_id: '67890',
                wa_access_token: 'newtoken'
            });

            const config = tenantManager.getWebhookConfig(tenantId);
            assert.equal(config.wa_phone_number_id, '67890');
            assert.equal(config.wa_access_token, 'newtoken');
            // Previous value should be preserved if not updated
            assert.equal(config.wa_verify_token, 'verify123');
        });

        test('clearWebhookChannel removes specific channel config', () => {
            tenantManager.clearWebhookChannel(tenantId, 'whatsapp');
            const config = tenantManager.getWebhookConfig(tenantId);
            assert.equal(config.wa_phone_number_id, null);
            assert.equal(config.wa_access_token, null);
            assert.equal(config.wa_verify_token, null);
            assert.equal(config.wa_webhook_verified, 0);
        });

        test('markWebhookVerified sets verification flag', () => {
            tenantManager.markWebhookVerified(tenantId, 'whatsapp');
            const config = tenantManager.getWebhookConfig(tenantId);
            assert.equal(config.wa_webhook_verified, 1);
        });
    });

    describe('Plans Management', () => {
        test('getAllPlans returns array (may be empty initially)', () => {
            const plans = tenantManager.getAllPlans();
            assert.ok(Array.isArray(plans));
        });

        test('createPlan adds new plan', () => {
            const plan = tenantManager.createPlan({
                name: 'Premium Plan',
                description: 'Premium features',
                price_cents: 9900,
                billing_cycle: 'monthly',
                max_services: 50,
                whatsapp_access: true,
                instagram_access: true,
                facebook_access: true,
                ai_calls_access: true
            });

            assert.ok(plan);
            assert.equal(plan.name, 'Premium Plan');
            assert.equal(plan.price_cents, 9900);
            assert.equal(plan.max_services, 50);
        });

        test('getPlanById returns correct plan', () => {
            const plans = tenantManager.getAllPlans();
            const firstPlan = plans[0];

            const plan = tenantManager.getPlanById(firstPlan.id);
            assert.ok(plan);
            assert.equal(plan.id, firstPlan.id);
        });

        test('updatePlan modifies existing plan', () => {
            const plans = tenantManager.getAllPlans();
            const firstPlan = plans[0];

            const updated = tenantManager.updatePlan(firstPlan.id, {
                name: 'Updated Plan Name',
                price_cents: 19900
            });

            assert.equal(updated.name, 'Updated Plan Name');
            assert.equal(updated.price_cents, 19900);
        });

        test('deletePlan soft-deletes plan', () => {
            const plan = tenantManager.createPlan({
                name: 'Temp Plan',
                price_cents: 1000,
                max_services: 10
            });

            tenantManager.deletePlan(plan.id);
            const deletedPlan = tenantManager.getPlanById(plan.id);
            assert.equal(deletedPlan.is_active, 0);
        });

        test('getActivePlans returns only active plans', () => {
            const activePlans = tenantManager.getActivePlans();
            for (const plan of activePlans) {
                assert.equal(plan.is_active, 1);
            }
        });
    });

    describe('getAllTenants()', () => {
        test('returns array of all tenants', async () => {
            // Create a few tenants
            await tenantManager.createTenant('List Owner 1', 'List Salon 1', 'list1@test.com', '1111111111', 'pass');
            await tenantManager.createTenant('List Owner 2', 'List Salon 2', 'list2@test.com', '2222222222', 'pass');

            const tenants = tenantManager.getAllTenants();
            assert.ok(Array.isArray(tenants));
            assert.ok(tenants.length >= 2);

            // Verify structure
            const firstTenant = tenants[0];
            assert.ok(firstTenant.tenant_id);
            assert.ok(firstTenant.owner_name);
            assert.ok(firstTenant.salon_name);
            assert.ok(firstTenant.email);
        });
    });

    describe('Password Reset Tokens', () => {
        let tenantId;
        const tokenHash = 'test_token_hash_123';

        before(async () => {
            tenantId = await tenantManager.createTenant(
                'Reset Owner',
                'Reset Salon',
                'reset@test.com',
                '9999999999',
                'password'
            );
        });

        test('storeResetToken saves token', () => {
            const expiresAt = new Date();
            expiresAt.setHours(expiresAt.getHours() + 1);

            tenantManager.storeResetToken(tenantId, tokenHash, expiresAt.toISOString());

            const token = tenantManager.getValidResetToken(tokenHash);
            assert.ok(token);
            assert.equal(token.tenant_id, tenantId);
            assert.equal(token.used, 0);
        });

        test('getValidResetToken returns null for expired token', () => {
            const expiredHash = 'expired_token';
            // SQLite datetime() compares as strings: must use 'YYYY-MM-DD HH:MM:SS' format
            // toISOString() uses 'T' separator (ASCII 84 > space 32), making past ISO dates
            // sort *after* datetime('now') in SQLite string comparison — a subtle trap.
            const expiredDate = new Date(Date.now() - 3_600_000);
            const sqliteFmt = expiredDate.toISOString().replace('T', ' ').slice(0, 19);

            tenantManager.storeResetToken(tenantId, expiredHash, sqliteFmt);

            const token = tenantManager.getValidResetToken(expiredHash);
            assert.equal(token, undefined);
        });

        test('markResetTokenUsed sets used flag', () => {
            const newHash = 'used_token_test';
            const expiresAt = new Date();
            expiresAt.setHours(expiresAt.getHours() + 1);

            tenantManager.storeResetToken(tenantId, newHash, expiresAt.toISOString());
            tenantManager.markResetTokenUsed(newHash);

            const token = tenantManager.getValidResetToken(newHash);
            assert.equal(token, undefined);
        });
    });
});