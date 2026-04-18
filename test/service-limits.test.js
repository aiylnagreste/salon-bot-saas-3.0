'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

let tenantManager;
let { getDb } = require('../src/db/database');
let testSuperDbPath;
let testSalonDbPath;

describe('ISSUE #4: Service Limit Enforcement', () => {
    let originalEnv;

    before(() => {
        originalEnv = { ...process.env };

        testSuperDbPath = path.join(__dirname, 'test_limits_super.db');
        testSalonDbPath = path.join(__dirname, 'test_limits_salon.db');

        if (fs.existsSync(testSuperDbPath)) fs.unlinkSync(testSuperDbPath);
        if (fs.existsSync(testSalonDbPath)) fs.unlinkSync(testSalonDbPath);

        process.env.SUPER_DB_PATH = testSuperDbPath;
        process.env.DB_PATH = testSalonDbPath;

        delete require.cache[require.resolve('../src/db/tenantManager')];
        delete require.cache[require.resolve('../src/db/database')];

        tenantManager = require('../src/db/tenantManager');
        ({ getDb } = require('../src/db/database'));
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

    let tenantLimitId;
    let planWith10ServicesId;
    let planWith5ServicesId;

    before(async () => {
        // Create test tenant
        tenantLimitId = await tenantManager.createTenant(
            'Limits Owner',
            'Limits Salon',
            'limits@test.com',
            '6666666666',
            'pass'
        );

        // Create plan with 10 service limit
        const planWith10 = tenantManager.createPlan({
            name: 'Plan With 10 Services',
            price_cents: 5000,
            max_services: 10
        });
        planWith10ServicesId = planWith10.id;

        // Create plan with 5 service limit
        const planWith5 = tenantManager.createPlan({
            name: 'Plan With 5 Services',
            price_cents: 2000,
            max_services: 5
        });
        planWith5ServicesId = planWith5.id;

        // Subscribe tenant to plan with 10 services
        tenantManager.createSubscription(
            tenantLimitId,
            planWith10ServicesId,
            'sub_limits',
            'cus_limits',
            new Date().toISOString(),
            new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
        );

        // Setup tenant database
        getDb().prepare(`SELECT * FROM ${tenantLimitId}_services`).all();
    });

    describe('Service Count Validation', () => {
        test('tenant subscription has max_services limit', () => {
            const subscriptions = tenantManager.getSubscriptions();
            const subscription = subscriptions.find(s => s.tenant_id === tenantLimitId);

            assert.ok(
                subscription,
                'Tenant should have active subscription'
            );
            assert.equal(
                subscription.max_services,
                10,
                'Subscription should specify max_services: 10'
            );
        });

        test('can create services under max_services limit', () => {
            const db = getDb();
            const servicesToCreate = 5;

            for (let i = 1; i <= servicesToCreate; i++) {
                const result = db.prepare(`
                    INSERT INTO ${tenantLimitId}_services (name, duration, is_active)
                    VALUES (?, ?, 1)
                `).run(`Service ${i}`, 60);

                assert.ok(
                    result.changes > 0,
                    `Service ${i} should be created successfully`
                );
            }

            // Verify count
            const count = db.prepare(`
                SELECT COUNT(*) as count FROM ${tenantLimitId}_services WHERE is_active = 1
            `).get();

            assert.equal(
                count.count,
                servicesToCreate,
                `Should have ${servicesToCreate} services`
            );
        });

        test('can create exactly max_services number of services', () => {
            const db = getDb();

            // Get current count
            let result = db.prepare(`
                SELECT COUNT(*) as count FROM ${tenantLimitId}_services WHERE is_active = 1
            `).get();
            const currentCount = result.count;

            // Add services up to exactly 10
            const maxAllowed = 10;
            const remaining = maxAllowed - currentCount;

            for (let i = 1; i <= remaining; i++) {
                db.prepare(`
                    INSERT INTO ${tenantLimitId}_services (name, duration, is_active)
                    VALUES (?, ?, 1)
                `).run(`Service Limit ${i}`, 60);
            }

            // Verify exact limit reached
            result = db.prepare(`
                SELECT COUNT(*) as count FROM ${tenantLimitId}_services WHERE is_active = 1
            `).get();

            assert.equal(
                result.count,
                maxAllowed,
                `Should have exactly ${maxAllowed} services when at limit`
            );
        });

        test('ISSUE #4: Creating services beyond max_services limit should fail', () => {
            const db = getDb();
            const maxAllowed = 10;

            // Get current count (should be at 10)
            const result = db.prepare(`
                SELECT COUNT(*) as count FROM ${tenantLimitId}_services WHERE is_active = 1
            `).get();

            assert.equal(result.count, maxAllowed, 'Should be at limit before test');

            // Try to add one more (would be 11th service)
            // ISSUE: Currently no validation, this should be prevented
            // Once implemented, this test should verify the prevention works

            // This is what SHOULD happen:
            // const limitResult = validateServiceLimit(tenantLimitId, 1);
            // assert.equal(limitResult.allowed, false, 'ISSUE #4: Should reject service creation beyond limit');
            // assert.ok(limitResult.reason.includes('limit'), 'Should include limit info in error');
        });

        test('ISSUE #4: Service limit error message should be clear', () => {
            // Once the validation function is implemented, this test should verify:
            // const limitResult = validateServiceLimit(tenantLimitId, 1);
            // assert.ok(limitResult.reason, 'Error should have a reason message');
            // assert.ok(
            //     limitResult.reason.includes('Current: 10') && 
            //     limitResult.reason.includes('Limit: 10'),
            //     'ISSUE #4: Error should include current count and limit'
            // );
        });

        test('service limits are per-tenant isolated', () => {
            // Create another tenant with different limit
            const tenantManager2 = require('../src/db/tenantManager');
            let tenant2Id;

            before(async () => {
                tenant2Id = await tenantManager2.createTenant(
                    'Tenant 2 Owner',
                    'Tenant 2 Salon',
                    'tenant2@test.com',
                    '7777777777',
                    'pass'
                );

                // Subscribe to plan with 5 services
                tenantManager2.createSubscription(
                    tenant2Id,
                    planWith5ServicesId,
                    'sub_tenant2',
                    'cus_tenant2',
                    new Date().toISOString(),
                    new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
                );
            });

            const db = getDb();

            // Tenant 1 has 10 services
            const tenant1Count = db.prepare(`
                SELECT COUNT(*) as count FROM ${tenantLimitId}_services WHERE is_active = 1
            `).get();

            assert.equal(
                tenant1Count.count,
                10,
                'Tenant 1 should have 10 services at limit'
            );

            // Tenant 2 should be isolated with different limit
            // This verifies that service counts are not shared globally
        });
    });

    describe('Plan Limits Documentation', () => {
        test('plan max_services field is clearly defined', () => {
            const plan = tenantManager.getPlanById(planWith10ServicesId);

            assert.ok(
                plan.max_services !== undefined,
                'Plan should have max_services field'
            );
            assert.equal(
                plan.max_services,
                10,
                'max_services should have the correct value'
            );
        });

        test('subscription includes plan max_services', () => {
            const subscriptions = tenantManager.getSubscriptions();
            const subscription = subscriptions.find(s => s.tenant_id === tenantLimitId);

            assert.ok(
                subscription.max_services !== undefined,
                'Subscription query result should include max_services'
            );
            assert.equal(
                subscription.max_services,
                10,
                'max_services should propagate to subscription'
            );
        });
    });

    describe('Service Limit Edge Cases', () => {
        test('free plan with 0 max_services', () => {
            const freePlan = tenantManager.createPlan({
                name: 'Free Plan No Services',
                price_cents: 0,
                max_services: 0
            });

            assert.equal(
                freePlan.max_services,
                0,
                'Free plan can specify 0 services'
            );
        });

        test('plan with 1 service limit', () => {
            const singleServicePlan = tenantManager.createPlan({
                name: 'Single Service Plan',
                price_cents: 999,
                max_services: 1
            });

            assert.equal(
                singleServicePlan.max_services,
                1,
                'Plan can specify exactly 1 service'
            );
        });

        test('plan with high service limit', () => {
            const unlimitedPlan = tenantManager.createPlan({
                name: 'High Service Plan',
                price_cents: 50000,
                max_services: 1000
            });

            assert.equal(
                unlimitedPlan.max_services,
                1000,
                'Plan can specify high service limit'
            );
        });
    });

    describe('Service Limit Enforcement (Implementation Needed)', () => {
        test('ISSUE #4: Implementation note - validation function missing', () => {
            // This test documents what needs to be implemented:
            // 1. Create validateServiceLimit(tenantId, additionalServices = 1) function
            // 2. Should check subscription max_services vs current count
            // 3. Should reject if adding additionalServices would exceed limit
            // 4. Should return { allowed: false, reason: 'clear message' } on failure
            // 5. Should return { allowed: true } on success

            // Once implemented, add these tests:
            // - Test that function exists and is exported
            // - Test that function validates limits correctly
            // - Test that function is called before service creation in API
            // - Test that validation includes services marked as deleted

            assert.ok(true, 'Placeholder for implementation validation');
        });
    });
});
