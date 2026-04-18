'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

let tenantManager;
let testSuperDbPath;
let testSalonDbPath;

describe('Tenant Feature Access', () => {
    let originalEnv;
    let testTenantId;

    before(async () => {
        originalEnv = { ...process.env };

        testSuperDbPath = path.join(__dirname, 'test_features_super.db');
        testSalonDbPath = path.join(__dirname, 'test_features_salon.db');

        if (fs.existsSync(testSuperDbPath)) fs.unlinkSync(testSuperDbPath);
        if (fs.existsSync(testSalonDbPath)) fs.unlinkSync(testSalonDbPath);

        process.env.SUPER_DB_PATH = testSuperDbPath;
        process.env.DB_PATH = testSalonDbPath;

        delete require.cache[require.resolve('../src/db/tenantManager')];
        delete require.cache[require.resolve('../src/db/database')];

        tenantManager = require('../src/db/tenantManager');

        // Create test tenant
        testTenantId = await tenantManager.createTenant(
            'Feature Test Owner',
            'Feature Test Salon',
            'features@test.com',
            '4444444444',
            'password'
        );
    });

    after(() => {
        try {
            const superDb = tenantManager.getSuperDb();
            if (superDb && superDb.close) superDb.close();
        } catch (err) { }

        setTimeout(() => {
            if (fs.existsSync(testSuperDbPath)) {
                try { fs.unlinkSync(testSuperDbPath); } catch (err) { }
            }
            if (fs.existsSync(testSalonDbPath)) {
                try { fs.unlinkSync(testSalonDbPath); } catch (err) { }
            }
        }, 100);

        process.env.DB_PATH = originalEnv.DB_PATH;
        process.env.SUPER_DB_PATH = originalEnv.SUPER_DB_PATH;
    });

    describe('Tenant Information', () => {
        test('getTenantById returns complete tenant info', () => {
            const tenant = tenantManager.getTenantById(testTenantId);
            assert.ok(tenant);
            assert.equal(tenant.tenant_id, testTenantId);
            assert.equal(tenant.owner_name, 'Feature Test Owner');
            assert.equal(tenant.salon_name, 'Feature Test Salon');
            assert.equal(tenant.email, 'features@test.com');
            assert.equal(tenant.phone, '4444444444');
            assert.equal(tenant.status, 'active');
        });

        test('getAllTenants includes test tenant', () => {
            const tenants = tenantManager.getAllTenants();
            const found = tenants.find(t => t.tenant_id === testTenantId);
            assert.ok(found);
        });
    });

    describe('Tenant Settings Management', () => {
        test('set and retrieve business settings', () => {
            const settings = {
                'business_hours_start': '09:00',
                'business_hours_end': '21:00',
                'timezone': 'Asia/Karachi',
                'currency': 'PKR',
                'cancellation_policy_hours': '24'
            };

            for (const [key, value] of Object.entries(settings)) {
                tenantManager.setTenantSetting(testTenantId, key, value);
            }

            for (const [key, value] of Object.entries(settings)) {
                const retrieved = tenantManager.getTenantSetting(testTenantId, key);
                assert.equal(retrieved, value);
            }
        });

        test('update existing setting', () => {
            tenantManager.setTenantSetting(testTenantId, 'test_setting', 'original');
            let value = tenantManager.getTenantSetting(testTenantId, 'test_setting');
            assert.equal(value, 'original');

            tenantManager.setTenantSetting(testTenantId, 'test_setting', 'updated');
            value = tenantManager.getTenantSetting(testTenantId, 'test_setting');
            assert.equal(value, 'updated');
        });

        test('get non-existent setting returns null', () => {
            const value = tenantManager.getTenantSetting(testTenantId, 'nonexistent_key_12345');
            assert.equal(value, null);
        });
    });

    describe('Tenant Status Management', () => {
        test('activate/inactivate tenant', () => {
            // Set to inactive
            tenantManager.updateTenantStatus(testTenantId, 'inactive');
            let tenant = tenantManager.getTenantById(testTenantId);
            assert.equal(tenant.status, 'inactive');
            assert.equal(tenantManager.isTenantActive(testTenantId), false);

            // Set back to active
            tenantManager.updateTenantStatus(testTenantId, 'active');
            tenant = tenantManager.getTenantById(testTenantId);
            assert.equal(tenant.status, 'active');
            assert.equal(tenantManager.isTenantActive(testTenantId), true);
        });

        test('updateTenantStatus updates timestamp', () => {
            const tenant = tenantManager.getTenantById(testTenantId);
            const originalUpdated = tenant.updated_at;

            // Wait a moment
            setTimeout(() => {
                tenantManager.updateTenantStatus(testTenantId, 'active');
                const updatedTenant = tenantManager.getTenantById(testTenantId);
                assert.notEqual(updatedTenant.updated_at, originalUpdated);
            }, 10);
        });
    });

    describe('Tenant Salon Name Management', () => {
        test('update salon name', () => {
            const newName = 'Updated Salon Name ' + Date.now();
            tenantManager.updateSalonName(testTenantId, newName);

            const tenant = tenantManager.getTenantById(testTenantId);
            assert.equal(tenant.salon_name, newName);
        });

        test('salon name update syncs to tenant_settings', () => {
            const setting = tenantManager.getTenantSetting(testTenantId, 'salon_name');
            const tenant = tenantManager.getTenantById(testTenantId);
            assert.equal(setting, tenant.salon_name);
        });
    });

    describe('Tenant Password Management', () => {
        let testPasswordTenantId;

        before(async () => {
            testPasswordTenantId = await tenantManager.createTenant(
                'Password Owner',
                'Password Salon',
                'password@test.com',
                '5555555555',
                'old_password'
            );
        });

        test('update tenant password', () => {
            tenantManager.updateTenantPassword(testPasswordTenantId, 'new_password');

            // Verify by authenticating with new password
            const auth = tenantManager.authenticateTenant('password@test.com', 'new_password');
            assert.ok(auth);
            assert.equal(auth.tenant_id, testPasswordTenantId);

            // Old password should not work
            const oldAuth = tenantManager.authenticateTenant('password@test.com', 'old_password');
            assert.equal(oldAuth, null);
        });
    });

    describe('Super Admin Management', () => {
        test('change super admin password', () => {
            const username = process.env.SUPER_ADMIN_USERNAME || 'superadmin';

            // Change password
            tenantManager.changeSuperAdminPassword(username, 'new_admin_pass');

            // Note: There's no authenticate function for super admin in the module
            // This just tests that the function runs without error
            assert.doesNotThrow(() => {
                tenantManager.changeSuperAdminPassword(username, 'admin123');
            });
        });
    });

    describe('Tenant Webhook Configuration', () => {
        test('store and retrieve webhook config', () => {
            const webhookConfig = {
                wa_phone_number_id: '123456789',
                wa_access_token: 'test_token_abc',
                wa_verify_token: 'verify_xyz',
                ig_page_access_token: 'ig_token_123',
                ig_verify_token: 'ig_verify',
                fb_page_access_token: 'fb_token_456',
                fb_verify_token: 'fb_verify'
            };

            tenantManager.upsertWebhookConfig(testTenantId, webhookConfig);
            const config = tenantManager.getWebhookConfig(testTenantId);

            assert.ok(config);
            assert.equal(config.wa_phone_number_id, '123456789');
            assert.equal(config.wa_access_token, 'test_token_abc');
            assert.equal(config.ig_page_access_token, 'ig_token_123');
            assert.equal(config.fb_page_access_token, 'fb_token_456');
        });

        test('clear specific webhook channel', () => {
            // Clear WhatsApp channel
            tenantManager.clearWebhookChannel(testTenantId, 'whatsapp');
            const config = tenantManager.getWebhookConfig(testTenantId);

            assert.equal(config.wa_phone_number_id, null);
            assert.equal(config.wa_access_token, null);
            assert.equal(config.wa_verify_token, null);
            assert.equal(config.wa_webhook_verified, 0);

            // Other channels remain
            assert.equal(config.ig_page_access_token, 'ig_token_123');
            assert.equal(config.fb_page_access_token, 'fb_token_456');
        });

        test('mark webhook as verified', () => {
            tenantManager.markWebhookVerified(testTenantId, 'whatsapp');
            const config = tenantManager.getWebhookConfig(testTenantId);
            assert.equal(config.wa_webhook_verified, 1);

            tenantManager.markWebhookVerified(testTenantId, 'instagram');
            const updatedConfig = tenantManager.getWebhookConfig(testTenantId);
            assert.equal(updatedConfig.ig_webhook_verified, 1);
        });
    });

    describe('Multiple Tenants Isolation', () => {
        let tenant1, tenant2;

        before(async () => {
            tenant1 = await tenantManager.createTenant(
                'Isolation Owner 1',
                'Isolation Salon 1',
                'isolation1@test.com',
                '6666666666',
                'pass1'
            );

            tenant2 = await tenantManager.createTenant(
                'Isolation Owner 2',
                'Isolation Salon 2',
                'isolation2@test.com',
                '7777777777',
                'pass2'
            );
        });

        test('tenants have separate settings', () => {
            tenantManager.setTenantSetting(tenant1, 'unique_key', 'value_for_tenant1');
            tenantManager.setTenantSetting(tenant2, 'unique_key', 'value_for_tenant2');

            const value1 = tenantManager.getTenantSetting(tenant1, 'unique_key');
            const value2 = tenantManager.getTenantSetting(tenant2, 'unique_key');

            assert.equal(value1, 'value_for_tenant1');
            assert.equal(value2, 'value_for_tenant2');
        });

        test('tenants have separate webhook configs', () => {
            tenantManager.upsertWebhookConfig(tenant1, { wa_access_token: 'tenant1_token' });
            tenantManager.upsertWebhookConfig(tenant2, { wa_access_token: 'tenant2_token' });

            const config1 = tenantManager.getWebhookConfig(tenant1);
            const config2 = tenantManager.getWebhookConfig(tenant2);

            assert.equal(config1.wa_access_token, 'tenant1_token');
            assert.equal(config2.wa_access_token, 'tenant2_token');
        });

        test('tenant status changes are isolated', () => {
            tenantManager.updateTenantStatus(tenant1, 'inactive');
            tenantManager.updateTenantStatus(tenant2, 'active');

            const status1 = tenantManager.isTenantActive(tenant1);
            const status2 = tenantManager.isTenantActive(tenant2);

            assert.equal(status1, false);
            assert.equal(status2, true);
        });
    });
});