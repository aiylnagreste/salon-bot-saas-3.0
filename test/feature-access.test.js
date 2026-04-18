'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

let tenantManager;
let testSuperDbPath;
let testSalonDbPath;

describe('ISSUE #3: Feature Access Control', () => {
    let originalEnv;

    before(() => {
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

    describe('Feature Availability in Plans', () => {
        let basicPlanId;
        let premiumPlanId;
        let customPlanId;

        before(() => {
            // Create basic plan with only WhatsApp
            const basicPlan = tenantManager.createPlan({
                name: 'Basic Feature Plan',
                price_cents: 1000,
                max_services: 10,
                whatsapp_access: true,
                instagram_access: false,
                facebook_access: false,
                ai_calls_access: false
            });
            basicPlanId = basicPlan.id;

            // Create premium plan with all features
            const premiumPlan = tenantManager.createPlan({
                name: 'Premium Feature Plan',
                price_cents: 10000,
                max_services: 100,
                whatsapp_access: true,
                instagram_access: true,
                facebook_access: true,
                ai_calls_access: true
            });
            premiumPlanId = premiumPlan.id;

            // Create custom plan with WhatsApp and Instagram only
            const customPlan = tenantManager.createPlan({
                name: 'Custom Feature Plan',
                price_cents: 5000,
                max_services: 50,
                whatsapp_access: true,
                instagram_access: true,
                facebook_access: false,
                ai_calls_access: false
            });
            customPlanId = customPlan.id;
        });

        test('ISSUE #3: Basic plan does NOT include Instagram', () => {
            const plan = tenantManager.getPlanById(basicPlanId);

            assert.equal(
                plan.instagram_access,
                0,
                'ISSUE #3: Instagram should not be available in basic plan (should be 0)'
            );
            assert.equal(
                plan.facebook_access,
                0,
                'ISSUE #3: Facebook should not be available in basic plan'
            );
            assert.equal(
                plan.ai_calls_access,
                0,
                'ISSUE #3: AI calls should not be available in basic plan'
            );
        });

        test('ISSUE #3: Basic plan includes only WhatsApp', () => {
            const plan = tenantManager.getPlanById(basicPlanId);

            assert.equal(
                plan.whatsapp_access,
                1,
                'Basic plan should include WhatsApp access'
            );
        });

        test('Premium plan includes all features', () => {
            const plan = tenantManager.getPlanById(premiumPlanId);

            assert.equal(plan.whatsapp_access, 1, 'Premium plan should include WhatsApp');
            assert.equal(plan.instagram_access, 1, 'Premium plan should include Instagram');
            assert.equal(plan.facebook_access, 1, 'Premium plan should include Facebook');
            assert.equal(plan.ai_calls_access, 1, 'Premium plan should include AI Calls');
        });

        test('Custom plan has selective features enabled', () => {
            const plan = tenantManager.getPlanById(customPlanId);

            assert.equal(plan.whatsapp_access, 1, 'Custom plan has WhatsApp');
            assert.equal(plan.instagram_access, 1, 'Custom plan has Instagram');
            assert.equal(plan.facebook_access, 0, 'Custom plan should NOT have Facebook');
            assert.equal(plan.ai_calls_access, 0, 'Custom plan should NOT have AI Calls');
        });
    });

    describe('Feature Display in Salon Admin Dashboard', () => {
        let tenantBasicId;
        let tenantPremiumId;
        let tenantCustomId;

        before(async () => {
            // Create tenants
            tenantBasicId = await tenantManager.createTenant(
                'Basic Owner',
                'Basic Salon',
                'basic@test.com',
                '1111111111',
                'pass'
            );

            tenantPremiumId = await tenantManager.createTenant(
                'Premium Owner',
                'Premium Salon',
                'premium@test.com',
                '2222222222',
                'pass'
            );

            tenantCustomId = await tenantManager.createTenant(
                'Custom Owner',
                'Custom Salon',
                'custom@test.com',
                '3333333333',
                'pass'
            );

            // Get plan IDs
            const plans = tenantManager.getAllPlans();
            const basicPlan = plans.find(p => p.name === 'Basic Feature Plan');
            const premiumPlan = plans.find(p => p.name === 'Premium Feature Plan');
            const customPlan = plans.find(p => p.name === 'Custom Feature Plan');

            // Subscribe tenants to plans
            tenantManager.createSubscription(
                tenantBasicId,
                basicPlan.id,
                'sub_basic',
                'cus_basic',
                new Date().toISOString(),
                new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
            );

            tenantManager.createSubscription(
                tenantPremiumId,
                premiumPlan.id,
                'sub_premium',
                'cus_premium',
                new Date().toISOString(),
                new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
            );

            tenantManager.createSubscription(
                tenantCustomId,
                customPlan.id,
                'sub_custom',
                'cus_custom',
                new Date().toISOString(),
                new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
            );
        });

        test('ISSUE #3: Salon-admin with basic plan should NOT see Instagram option', () => {
            const subscriptions = tenantManager.getSubscriptions();
            const basicSub = subscriptions.find(s => s.tenant_id === tenantBasicId);

            assert.ok(basicSub, 'Basic tenant should have subscription');
            assert.equal(
                basicSub.whatsapp_access,
                1,
                'Basic tenant should see WhatsApp option'
            );
            assert.equal(
                basicSub.instagram_access,
                0,
                'ISSUE #3: Basic tenant should NOT see Instagram option (should be hidden in UI)'
            );
            assert.equal(
                basicSub.facebook_access,
                0,
                'ISSUE #3: Basic tenant should NOT see Facebook option'
            );
        });

        test('ISSUE #3: Salon-admin with basic plan should NOT see Facebook option', () => {
            const subscriptions = tenantManager.getSubscriptions();
            const basicSub = subscriptions.find(s => s.tenant_id === tenantBasicId);

            assert.equal(
                basicSub.facebook_access,
                0,
                'ISSUE #3: Facebook option should be hidden for basic plan'
            );
        });

        test('Salon-admin with premium plan sees all options', () => {
            const subscriptions = tenantManager.getSubscriptions();
            const premiumSub = subscriptions.find(s => s.tenant_id === tenantPremiumId);

            assert.equal(premiumSub.whatsapp_access, 1, 'Should see WhatsApp');
            assert.equal(premiumSub.instagram_access, 1, 'Should see Instagram');
            assert.equal(premiumSub.facebook_access, 1, 'Should see Facebook');
            assert.equal(premiumSub.ai_calls_access, 1, 'Should see AI Calls');
        });

        test('Salon-admin with custom plan sees only subscribed features', () => {
            const subscriptions = tenantManager.getSubscriptions();
            const customSub = subscriptions.find(s => s.tenant_id === tenantCustomId);

            assert.equal(customSub.whatsapp_access, 1, 'Custom should see WhatsApp');
            assert.equal(customSub.instagram_access, 1, 'Custom should see Instagram');
            assert.equal(customSub.facebook_access, 0, 'Custom should NOT see Facebook');
            assert.equal(customSub.ai_calls_access, 0, 'Custom should NOT see AI Calls');
        });

        test('Feature visibility matches plan subscription', () => {
            const subscriptions = tenantManager.getSubscriptions();

            // Verify each tenant sees only their subscribed features
            const tenants = [
                { id: tenantBasicId, expected: { wa: 1, ig: 0, fb: 0 } },
                { id: tenantPremiumId, expected: { wa: 1, ig: 1, fb: 1 } },
                { id: tenantCustomId, expected: { wa: 1, ig: 1, fb: 0 } }
            ];

            for (const tenant of tenants) {
                const sub = subscriptions.find(s => s.tenant_id === tenant.id);
                assert.equal(
                    sub.whatsapp_access,
                    tenant.expected.wa,
                    `Tenant ${tenant.id} WhatsApp mismatch`
                );
                assert.equal(
                    sub.instagram_access,
                    tenant.expected.ig,
                    `Tenant ${tenant.id} Instagram mismatch`
                );
                assert.equal(
                    sub.facebook_access,
                    tenant.expected.fb,
                    `Tenant ${tenant.id} Facebook mismatch`
                );
            }
        });
    });

    describe('Feature Changes on Plan Upgrade/Downgrade', () => {
        let upgradeTestTenantId;

        before(async () => {
            upgradeTestTenantId = await tenantManager.createTenant(
                'Upgrade Test Owner',
                'Upgrade Test Salon',
                'upgrade@test.com',
                '4444444444',
                'pass'
            );

            // Subscribe to basic plan initially
            const plans = tenantManager.getAllPlans();
            const basicPlan = plans.find(p => p.name === 'Basic Feature Plan');
            tenantManager.createSubscription(
                upgradeTestTenantId,
                basicPlan.id,
                'sub_upgrade_initial',
                'cus_upgrade',
                new Date().toISOString(),
                new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
            );
        });

        test('Features update when upgrading to premium plan', () => {
            const plans = tenantManager.getAllPlans();
            const premiumPlan = plans.find(p => p.name === 'Premium Feature Plan');

            // Upgrade
            tenantManager.createSubscription(
                upgradeTestTenantId,
                premiumPlan.id,
                'sub_upgrade_premium',
                'cus_upgrade',
                new Date().toISOString(),
                new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
            );

            const subscriptions = tenantManager.getSubscriptions();
            const upgraded = subscriptions.find(
                s => s.tenant_id === upgradeTestTenantId && s.stripe_subscription_id === 'sub_upgrade_premium'
            );

            assert.equal(upgraded.whatsapp_access, 1, 'Should have WhatsApp after upgrade');
            assert.equal(upgraded.instagram_access, 1, 'Should NOW have Instagram after upgrade');
            assert.equal(upgraded.facebook_access, 1, 'Should NOW have Facebook after upgrade');
            assert.equal(upgraded.ai_calls_access, 1, 'Should NOW have AI Calls after upgrade');
        });

        test('Features restrict when downgrading from premium plan', () => {
            const plans = tenantManager.getAllPlans();
            const basicPlan = plans.find(p => p.name === 'Basic Feature Plan');

            // Downgrade
            tenantManager.createSubscription(
                upgradeTestTenantId,
                basicPlan.id,
                'sub_downgrade_basic',
                'cus_upgrade',
                new Date().toISOString(),
                new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
            );

            const subscriptions = tenantManager.getSubscriptions();
            const downgraded = subscriptions.find(
                s => s.tenant_id === upgradeTestTenantId && s.stripe_subscription_id === 'sub_downgrade_basic'
            );

            assert.equal(downgraded.whatsapp_access, 1, 'Should still have WhatsApp');
            assert.equal(downgraded.instagram_access, 0, 'Should NO LONGER have Instagram after downgrade');
            assert.equal(downgraded.facebook_access, 0, 'Should NO LONGER have Facebook after downgrade');
            assert.equal(downgraded.ai_calls_access, 0, 'Should NO LONGER have AI Calls after downgrade');
        });
    });
});
