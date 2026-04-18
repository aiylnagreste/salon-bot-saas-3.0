'use strict';
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

let tenantManager;
let testSuperDbPath;
let testSalonDbPath;

describe('Plans and Subscriptions Management', () => {
    let originalEnv;

    before(() => {
        originalEnv = { ...process.env };

        // Create temporary database paths
        testSuperDbPath = path.join(__dirname, 'test_plans_super.db');
        testSalonDbPath = path.join(__dirname, 'test_plans_salon.db');

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
        // Close connections
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

    describe('Plans CRUD Operations', () => {
        let createdPlanId;

        test('getAllPlans returns array (initially empty or with seeded data)', () => {
            const plans = tenantManager.getAllPlans();
            assert.ok(Array.isArray(plans));
        });

        test('createPlan adds new plan with all features', () => {
            const plan = tenantManager.createPlan({
                name: 'Premium Plan',
                description: 'Premium features for salons',
                price_cents: 9900,
                billing_cycle: 'monthly',
                max_services: 100,
                whatsapp_access: true,
                instagram_access: true,
                facebook_access: true,
                ai_calls_access: true,
                stripe_price_id: 'price_premium_monthly'
            });

            assert.ok(plan);
            assert.ok(plan.id);
            assert.equal(plan.name, 'Premium Plan');
            assert.equal(plan.price_cents, 9900);
            assert.equal(plan.billing_cycle, 'monthly');
            assert.equal(plan.max_services, 100);
            assert.equal(plan.whatsapp_access, 1);
            assert.equal(plan.instagram_access, 1);
            assert.equal(plan.facebook_access, 1);
            assert.equal(plan.ai_calls_access, 1);
            assert.equal(plan.is_active, 1);

            createdPlanId = plan.id;
        });

        test('createPlan with minimal data', () => {
            const plan = tenantManager.createPlan({
                name: 'Basic Plan',
                price_cents: 2900,
                max_services: 20
            });

            assert.ok(plan);
            assert.equal(plan.name, 'Basic Plan');
            assert.equal(plan.price_cents, 2900);
            assert.equal(plan.billing_cycle, 'monthly'); // Default
            assert.equal(plan.max_services, 20);
            assert.equal(plan.whatsapp_access, 0);
            assert.equal(plan.instagram_access, 0);
            assert.equal(plan.facebook_access, 0);
            assert.equal(plan.ai_calls_access, 0);
        });

        test('createPlan with yearly billing', () => {
            const plan = tenantManager.createPlan({
                name: 'Yearly Premium',
                price_cents: 99000,
                billing_cycle: 'yearly',
                max_services: 200,
                whatsapp_access: true
            });

            assert.ok(plan);
            assert.equal(plan.billing_cycle, 'yearly');
            assert.equal(plan.price_cents, 99000);
        });

        test('getPlanById returns correct plan', () => {
            const plan = tenantManager.getPlanById(createdPlanId);
            assert.ok(plan);
            assert.equal(plan.id, createdPlanId);
            assert.equal(plan.name, 'Premium Plan');
        });

        test('getPlanById returns undefined for non-existent plan', () => {
            const plan = tenantManager.getPlanById(99999);
            assert.equal(plan, undefined);
        });

        test('updatePlan modifies existing plan', () => {
            const updated = tenantManager.updatePlan(createdPlanId, {
                name: 'Premium Plus Plan',
                price_cents: 14900,
                max_services: 150,
                whatsapp_access: true,
                instagram_access: true,
                facebook_access: true,
                ai_calls_access: false
            });

            assert.equal(updated.name, 'Premium Plus Plan');
            assert.equal(updated.price_cents, 14900);
            assert.equal(updated.max_services, 150);
            assert.equal(updated.ai_calls_access, 0);
            // Unchanged fields remain
            assert.equal(updated.billing_cycle, 'monthly');
        });

        test('updatePlan partial update', () => {
            const updated = tenantManager.updatePlan(createdPlanId, {
                price_cents: 19900
            });

            assert.equal(updated.price_cents, 19900);
            assert.equal(updated.name, 'Premium Plus Plan'); // Unchanged
        });

        test('deletePlan soft-deletes plan', () => {
            const plan = tenantManager.createPlan({
                name: 'Temporary Plan',
                price_cents: 1000,
                max_services: 5
            });

            tenantManager.deletePlan(plan.id);
            const deletedPlan = tenantManager.getPlanById(plan.id);
            assert.equal(deletedPlan.is_active, 0);
        });

        test('getActivePlans returns only active plans', () => {
            // Create active plan
            tenantManager.createPlan({
                name: 'Active Plan Test',
                price_cents: 5000,
                max_services: 30,
                is_active: 1
            });

            // Create inactive plan
            const inactive = tenantManager.createPlan({
                name: 'Inactive Plan Test',
                price_cents: 3000,
                max_services: 15
            });
            tenantManager.deletePlan(inactive.id);

            const activePlans = tenantManager.getActivePlans();
            for (const plan of activePlans) {
                assert.equal(plan.is_active, 1);
            }
        });

        test('hardDeletePlan permanently removes plan', () => {
            const plan = tenantManager.createPlan({
                name: 'To Delete Forever',
                price_cents: 1000,
                max_services: 5
            });

            tenantManager.hardDeletePlan(plan.id);
            const deletedPlan = tenantManager.getPlanById(plan.id);
            assert.equal(deletedPlan, undefined);
        });
    });

    describe('Subscriptions Management', () => {
        let tenantId;
        let planId;

        before(async () => {
            // Create a tenant for subscription tests
            tenantId = await tenantManager.createTenant(
                'Subscription Owner',
                'Subscription Salon',
                'subscription@test.com',
                '1111111111',
                'password123'
            );

            // Create a plan
            const plan = tenantManager.createPlan({
                name: 'Subscription Test Plan',
                price_cents: 5000,
                billing_cycle: 'monthly',
                max_services: 50,
                whatsapp_access: true
            });
            planId = plan.id;
        });

        test('createSubscription creates new subscription', () => {
            const periodStart = new Date().toISOString();
            const periodEnd = new Date();
            periodEnd.setMonth(periodEnd.getMonth() + 1);

            const subscription = tenantManager.createSubscription(
                tenantId,
                planId,
                'sub_stripe_123',
                'cus_stripe_456',
                periodStart,
                periodEnd.toISOString()
            );

            assert.ok(subscription);
            assert.ok(subscription.id);
            assert.equal(subscription.tenant_id, tenantId);
            assert.equal(subscription.plan_id, planId);
            assert.equal(subscription.status, 'active');
            assert.equal(subscription.stripe_subscription_id, 'sub_stripe_123');
            assert.equal(subscription.stripe_customer_id, 'cus_stripe_456');
        });

        test('createSubscription without Stripe IDs', () => {
            const periodStart = new Date().toISOString();
            const periodEnd = new Date();
            periodEnd.setMonth(periodEnd.getMonth() + 1);

            const subscription = tenantManager.createSubscription(
                tenantId,
                planId,
                null,
                null,
                periodStart,
                periodEnd.toISOString()
            );

            assert.ok(subscription);
            assert.equal(subscription.stripe_subscription_id, null);
            assert.equal(subscription.stripe_customer_id, null);
        });

        test('createSubscription updates tenant subscription_plan field', () => {
            const tenant = tenantManager.getTenantById(tenantId);
            assert.equal(tenant.subscription_plan, 'Subscription Test Plan');
            assert.ok(tenant.subscription_expires);
        });

        test('getSubscriptions returns all subscriptions', () => {
            const subscriptions = tenantManager.getSubscriptions();
            assert.ok(Array.isArray(subscriptions));
            assert.ok(subscriptions.length >= 1);

            const found = subscriptions.find(s => s.tenant_id === tenantId);
            assert.ok(found);
            assert.equal(found.plan_name, 'Subscription Test Plan');
            assert.equal(found.salon_name, 'Subscription Salon');
        });

        test('multiple subscriptions per tenant (history)', () => {
            // Create new plan
            const newPlan = tenantManager.createPlan({
                name: 'Upgraded Plan',
                price_cents: 10000,
                max_services: 100
            });

            const periodStart = new Date().toISOString();
            const periodEnd = new Date();
            periodEnd.setMonth(periodEnd.getMonth() + 1);

            const subscription = tenantManager.createSubscription(
                tenantId,
                newPlan.id,
                'sub_stripe_upgraded',
                'cus_stripe_456',
                periodStart,
                periodEnd.toISOString()
            );

            assert.ok(subscription);

            // Check tenant has updated plan
            const tenant = tenantManager.getTenantById(tenantId);
            assert.equal(tenant.subscription_plan, 'Upgraded Plan');

            // Both subscriptions should exist in history
            const subscriptions = tenantManager.getSubscriptions();
            const tenantSubs = subscriptions.filter(s => s.tenant_id === tenantId);
            assert.ok(tenantSubs.length >= 2);
        });
    });

    describe('Plan Limits and Access Control', () => {
        let tenantId;
        let basicPlanId;
        let premiumPlanId;

        before(async () => {
            tenantId = await tenantManager.createTenant(
                'Limits Owner',
                'Limits Salon',
                'limits@test.com',
                '2222222222',
                'password'
            );

            const basicPlan = tenantManager.createPlan({
                name: 'Basic Limits Plan',
                price_cents: 1000,
                max_services: 10,
                whatsapp_access: true,
                instagram_access: false,
                facebook_access: false,
                ai_calls_access: false
            });
            basicPlanId = basicPlan.id;

            const premiumPlan = tenantManager.createPlan({
                name: 'Premium Limits Plan',
                price_cents: 5000,
                max_services: 100,
                whatsapp_access: true,
                instagram_access: true,
                facebook_access: true,
                ai_calls_access: true
            });
            premiumPlanId = premiumPlan.id;
        });

        test('basic plan has limited features', () => {
            const plan = tenantManager.getPlanById(basicPlanId);
            assert.equal(plan.max_services, 10);
            assert.equal(plan.whatsapp_access, 1);
            assert.equal(plan.instagram_access, 0);
            assert.equal(plan.facebook_access, 0);
            assert.equal(plan.ai_calls_access, 0);
        });

        test('premium plan has all features', () => {
            const plan = tenantManager.getPlanById(premiumPlanId);
            assert.equal(plan.max_services, 100);
            assert.equal(plan.whatsapp_access, 1);
            assert.equal(plan.instagram_access, 1);
            assert.equal(plan.facebook_access, 1);
            assert.equal(plan.ai_calls_access, 1);
        });

        test('can upgrade tenant to premium plan', () => {
            const periodStart = new Date().toISOString();
            const periodEnd = new Date();
            periodEnd.setMonth(periodEnd.getMonth() + 1);

            const subscription = tenantManager.createSubscription(
                tenantId,
                premiumPlanId,
                'sub_upgrade_test',
                'cus_upgrade',
                periodStart,
                periodEnd.toISOString()
            );

            assert.ok(subscription);

            const tenant = tenantManager.getTenantById(tenantId);
            assert.equal(tenant.subscription_plan, 'Premium Limits Plan');
        });

        test('can downgrade tenant to basic plan', () => {
            const periodStart = new Date().toISOString();
            const periodEnd = new Date();
            periodEnd.setMonth(periodEnd.getMonth() + 1);

            const subscription = tenantManager.createSubscription(
                tenantId,
                basicPlanId,
                'sub_downgrade_test',
                'cus_downgrade',
                periodStart,
                periodEnd.toISOString()
            );

            assert.ok(subscription);

            const tenant = tenantManager.getTenantById(tenantId);
            assert.equal(tenant.subscription_plan, 'Basic Limits Plan');
        });
    });

    describe('Subscription Edge Cases', () => {
        let tenantId;
        let planId;

        before(async () => {
            tenantId = await tenantManager.createTenant(
                'Edge Owner',
                'Edge Salon',
                'edge@test.com',
                '3333333333',
                'password'
            );

            const plan = tenantManager.createPlan({
                name: 'Edge Test Plan',
                price_cents: 1000,
                max_services: 10
            });
            planId = plan.id;
        });

        test('subscription with future start date', () => {
            const periodStart = new Date();
            periodStart.setMonth(periodStart.getMonth() + 1);
            const periodEnd = new Date();
            periodEnd.setMonth(periodEnd.getMonth() + 2);

            const subscription = tenantManager.createSubscription(
                tenantId,
                planId,
                null,
                null,
                periodStart.toISOString(),
                periodEnd.toISOString()
            );

            assert.ok(subscription);
            assert.ok(subscription.current_period_start);
            assert.ok(subscription.current_period_end);
        });

        test('subscription with past end date (expired)', () => {
            const periodStart = new Date();
            periodStart.setMonth(periodStart.getMonth() - 2);
            const periodEnd = new Date();
            periodEnd.setMonth(periodEnd.getMonth() - 1);

            const subscription = tenantManager.createSubscription(
                tenantId,
                planId,
                null,
                null,
                periodStart.toISOString(),
                periodEnd.toISOString()
            );

            assert.ok(subscription);
            // Tenant should still have the plan reference
            const tenant = tenantManager.getTenantById(tenantId);
            assert.ok(tenant.subscription_plan);
        });
    });

    describe('Plan Pricing and Currency', () => {
        test('plans with different price points', () => {
            const prices = [0, 500, 1000, 5000, 10000, 50000];

            for (const price of prices) {
                const plan = tenantManager.createPlan({
                    name: `Price Test ${price}`,
                    price_cents: price,
                    max_services: 10
                });

                assert.equal(plan.price_cents, price);
            }
        });

        test('free plan (price 0)', () => {
            const freePlan = tenantManager.createPlan({
                name: 'Free Plan',
                price_cents: 0,
                max_services: 5,
                whatsapp_access: false
            });

            assert.equal(freePlan.price_cents, 0);
            assert.equal(freePlan.max_services, 5);
        });
    });

    describe('Plan Validation', () => {
        test('plan requires name', () => {
            assert.throws(() => {
                tenantManager.createPlan({
                    price_cents: 1000,
                    max_services: 10
                });
            }, /name/i);
        });

        test('plan requires price_cents', () => {
            assert.throws(() => {
                tenantManager.createPlan({
                    name: 'No Price Plan',
                    max_services: 10
                });
            });
        });

        test('plan requires max_services', () => {
            assert.throws(() => {
                tenantManager.createPlan({
                    name: 'No Services Plan',
                    price_cents: 1000
                });
            });
        });
    });
});