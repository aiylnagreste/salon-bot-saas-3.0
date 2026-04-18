'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

let tenantManager;
let testSuperDbPath;
let testSalonDbPath;

describe('Subscription Validation - Period Dates', () => {
    let originalEnv;

    before(() => {
        originalEnv = { ...process.env };

        // Create temporary database paths
        testSuperDbPath = path.join(__dirname, 'test_subval_super.db');
        testSalonDbPath = path.join(__dirname, 'test_subval_salon.db');

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

    let testTenantId;
    let testPlanId;

    before(async () => {
        // Create test tenant
        testTenantId = await tenantManager.createTenant(
            'Validation Owner',
            'Validation Salon',
            'validation@test.com',
            '5555555555',
            'password123'
        );

        // Create test plan
        const plan = tenantManager.createPlan({
            name: 'Validation Test Plan',
            price_cents: 5000,
            billing_cycle: 'monthly',
            max_services: 50
        });
        testPlanId = plan.id;
    });

    describe('ISSUE #1: subscription_expires in salon_tenants', () => {
        test('subscription_expires is NOT null after subscription creation', () => {
            const periodEnd = new Date();
            periodEnd.setMonth(periodEnd.getMonth() + 1);
            const endDate = periodEnd.toISOString();

            tenantManager.createSubscription(
                testTenantId,
                testPlanId,
                'sub_test_123',
                'cus_test_456',
                new Date().toISOString(),
                endDate
            );

            const tenant = tenantManager.getTenantById(testTenantId);

            assert.notEqual(
                tenant.subscription_expires,
                null,
                'ISSUE #1: subscription_expires should NOT be null in salon_tenants'
            );
            assert.ok(
                tenant.subscription_expires,
                'subscription_expires should have a truthy value'
            );
        });

        test('subscription_expires equals subscription end date', () => {
            const periodStart = new Date().toISOString();
            const periodEnd = new Date();
            periodEnd.setMonth(periodEnd.getMonth() + 2);
            const endDate = periodEnd.toISOString();

            const subscription = tenantManager.createSubscription(
                testTenantId,
                testPlanId,
                'sub_test_567',
                'cus_test_890',
                periodStart,
                endDate
            );

            const tenant = tenantManager.getTenantById(testTenantId);

            assert.equal(
                tenant.subscription_expires,
                subscription.current_period_end,
                'subscription_expires in salon_tenants should match current_period_end in subscriptions'
            );
        });

        test('latest subscription updates subscription_expires', () => {
            // Create first subscription
            const end1 = new Date();
            end1.setMonth(end1.getMonth() + 1);

            tenantManager.createSubscription(
                testTenantId,
                testPlanId,
                'sub_first',
                'cus_first',
                new Date().toISOString(),
                end1.toISOString()
            );

            const tenant1 = tenantManager.getTenantById(testTenantId);
            const expires1 = tenant1.subscription_expires;

            // Create second subscription with later end date
            const end2 = new Date();
            end2.setMonth(end2.getMonth() + 3);

            tenantManager.createSubscription(
                testTenantId,
                testPlanId,
                'sub_second',
                'cus_second',
                new Date().toISOString(),
                end2.toISOString()
            );

            const tenant2 = tenantManager.getTenantById(testTenantId);
            const expires2 = tenant2.subscription_expires;

            assert.notEqual(
                expires2,
                expires1,
                'subscription_expires should update when new subscription is created'
            );
        });
    });

    describe('ISSUE #2: current_period_start and current_period_end', () => {
        test('current_period_start is NOT null after creation', () => {
            const startDate = new Date().toISOString();
            const endDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

            const subscription = tenantManager.createSubscription(
                testTenantId,
                testPlanId,
                'sub_start_test',
                'cus_start',
                startDate,
                endDate
            );

            assert.notEqual(
                subscription.current_period_start,
                null,
                'ISSUE #2: current_period_start should NOT be null'
            );
            assert.ok(
                subscription.current_period_start,
                'current_period_start should have a truthy value'
            );
        });

        test('current_period_end is NOT null after creation', () => {
            const startDate = new Date().toISOString();
            const endDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

            const subscription = tenantManager.createSubscription(
                testTenantId,
                testPlanId,
                'sub_end_test',
                'cus_end',
                startDate,
                endDate
            );

            assert.notEqual(
                subscription.current_period_end,
                null,
                'ISSUE #2: current_period_end should NOT be null'
            );
            assert.ok(
                subscription.current_period_end,
                'current_period_end should have a truthy value'
            );
        });

        test('period dates match provided values', () => {
            const startDate = new Date().toISOString();
            const periodEnd = new Date();
            periodEnd.setDate(periodEnd.getDate() + 30);
            const endDate = periodEnd.toISOString();

            const subscription = tenantManager.createSubscription(
                testTenantId,
                testPlanId,
                'sub_match_test',
                'cus_match',
                startDate,
                endDate
            );

            // Allow for small timestamp differences (milliseconds)
            const startMatch = subscription.current_period_start.substring(0, 19) === startDate.substring(0, 19);
            const endMatch = subscription.current_period_end.substring(0, 19) === endDate.substring(0, 19);

            assert.ok(
                startMatch,
                `current_period_start should match provided start date. Expected: ${startDate}, Got: ${subscription.current_period_start}`
            );
            assert.ok(
                endMatch,
                `current_period_end should match provided end date. Expected: ${endDate}, Got: ${subscription.current_period_end}`
            );
        });

        test('period dates survive database queries', () => {
            const startDate = new Date().toISOString();
            const endDate = new Date(Date.now() + 45 * 24 * 60 * 60 * 1000).toISOString();

            const created = tenantManager.createSubscription(
                testTenantId,
                testPlanId,
                'sub_persist_test',
                'cus_persist',
                startDate,
                endDate
            );

            // Query subscriptions
            const subscriptions = tenantManager.getSubscriptions();
            const queried = subscriptions.find(s => s.stripe_subscription_id === 'sub_persist_test');

            assert.ok(queried, 'Subscription should be retrievable via getSubscriptions');
            assert.notEqual(queried.current_period_start, null, 'Queried subscription should have current_period_start');
            assert.notEqual(queried.current_period_end, null, 'Queried subscription should have current_period_end');
            assert.equal(queried.current_period_start, created.current_period_start, 'Queried start date should match');
            assert.equal(queried.current_period_end, created.current_period_end, 'Queried end date should match');
        });

        test('expired subscriptions retain period dates', () => {
            const startDate = new Date();
            startDate.setMonth(startDate.getMonth() - 2);

            const endDate = new Date();
            endDate.setMonth(endDate.getMonth() - 1);

            const subscription = tenantManager.createSubscription(
                testTenantId,
                testPlanId,
                'sub_expired_test',
                'cus_expired',
                startDate.toISOString(),
                endDate.toISOString()
            );

            assert.ok(
                subscription.current_period_start,
                'Expired subscription should retain current_period_start'
            );
            assert.ok(
                subscription.current_period_end,
                'Expired subscription should retain current_period_end'
            );

            // Verify end date is in the past
            const now = new Date();
            const end = new Date(subscription.current_period_end);
            assert.ok(
                end < now,
                'Subscription end date should be in the past'
            );
        });

        test('subscription periods consistent across multiple queries', () => {
            const startDate = new Date().toISOString();
            const endDate = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString();

            const created = tenantManager.createSubscription(
                testTenantId,
                testPlanId,
                'sub_consistency_test',
                'cus_consistency',
                startDate,
                endDate
            );

            // Query multiple times
            const subs1 = tenantManager.getSubscriptions();
            const query1 = subs1.find(s => s.id === created.id);

            const subs2 = tenantManager.getSubscriptions();
            const query2 = subs2.find(s => s.id === created.id);

            assert.equal(
                query1.current_period_start,
                query2.current_period_start,
                'current_period_start should be consistent across queries'
            );
            assert.equal(
                query1.current_period_end,
                query2.current_period_end,
                'current_period_end should be consistent across queries'
            );
            assert.equal(
                query1.current_period_start,
                created.current_period_start,
                'current_period_start should match original creation'
            );
        });
    });

    describe('Subscription Display in Admin UI', () => {
        test('tenant subscription info displays correctly via getAllTenants', () => {
            const allTenants = tenantManager.getAllTenants();
            const foundTenant = allTenants.find(t => t.tenant_id === testTenantId);

            assert.ok(foundTenant, 'Tenant should be in getAllTenants results');
            assert.ok(
                foundTenant.subscription_plan,
                'Tenant should have subscription_plan for display'
            );
            assert.ok(
                foundTenant.subscription_expires,
                'Tenant should have subscription_expires for display'
            );
        });
    });
});
