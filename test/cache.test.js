'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

let apiModule;

describe('API Routes', () => {
    before(() => {
        delete require.cache[require.resolve('../src/index')];
        apiModule = require('../src/index');
    });

    describe('Booking Routes', () => {
        test('POST /api/bookings validates required fields', async () => {
            const invalidBooking = {
                customer_name: 'Test',
                // Missing phone, service, date, time
            };

            const result = await apiModule.createBooking(invalidBooking);
            assert.ok(result.error);
            assert.match(result.error, /required/i);
        });

        test('POST /api/bookings accepts valid booking', async () => {
            const validBooking = {
                tenantId: 'SA_01',
                customer_name: 'Ahmad Ali',
                phone: '+923001234567',
                service: 'Haircut',
                branch: 'Gulberg',
                date: '2024-12-25',
                time: '14:30'
            };

            const result = await apiModule.createBooking(validBooking);
            assert.ok(result);
            assert.ok(result.id);
            assert.equal(result.status, 'confirmed');
        });

        test('GET /api/bookings/:id returns booking', async () => {
            const bookingId = 1;
            const result = await apiModule.getBooking(bookingId);

            assert.ok(result);
            assert.equal(result.id, bookingId);
        });

        test('PUT /api/bookings/:id updates status', async () => {
            const update = {
                id: 1,
                status: 'completed',
                tenantId: 'SA_01'
            };

            const result = await apiModule.updateBooking(update);
            assert.equal(result.status, 'completed');
        });

        test('DELETE /api/bookings/:id soft deletes', async () => {
            const result = await apiModule.deleteBooking(1, 'SA_01');
            assert.ok(result);
            assert.equal(result.status, 'cancelled');
        });
    });

    describe('Services Routes', () => {
        test('GET /api/services returns services', async () => {
            const services = await apiModule.getServices('SA_01');
            assert.ok(Array.isArray(services));
        });

        test('POST /api/services creates service', async () => {
            const newService = {
                tenantId: 'SA_01',
                name: 'New Test Service',
                price: 'Rs. 1000',
                durationMinutes: 45
            };

            const result = await apiModule.createService(newService);
            assert.ok(result);
            assert.equal(result.name, 'New Test Service');
        });

        test('PUT /api/services/:id updates service', async () => {
            const update = {
                id: 1,
                name: 'Updated Service Name',
                price: 'Rs. 1500'
            };

            const result = await apiModule.updateService(update);
            assert.equal(result.name, 'Updated Service Name');
        });
    });

    describe('Staff Routes', () => {
        test('GET /api/staff returns staff list', async () => {
            const staff = await apiModule.getStaff('SA_01');
            assert.ok(Array.isArray(staff));
        });

        test('POST /api/staff adds new staff', async () => {
            const newStaff = {
                tenantId: 'SA_01',
                name: 'New Stylist',
                phone: '03001234567',
                role: 'stylist',
                branch_id: 1
            };

            const result = await apiModule.createStaff(newStaff);
            assert.ok(result);
            assert.equal(result.name, 'New Stylist');
        });

        test('GET /api/staff/availability checks staff schedule', async () => {
            const availability = await apiModule.checkStaffAvailability({
                staffId: 1,
                date: '2024-12-25',
                tenantId: 'SA_01'
            });

            assert.ok(availability.hasOwnProperty('available'));
        });
    });

    describe('Branch Routes', () => {
        test('GET /api/branches returns branches', async () => {
            const branches = await apiModule.getBranches('SA_01');
            assert.ok(Array.isArray(branches));
            assert.ok(branches.length > 0);
        });

        test('GET /api/branches/:id returns specific branch', async () => {
            const branch = await apiModule.getBranch(1, 'SA_01');
            assert.ok(branch);
            assert.equal(branch.id, 1);
        });
    });

    describe('Authentication Routes', () => {
        test('POST /api/auth/login authenticates tenant', async () => {
            const credentials = {
                email: 'test@salon.com',
                password: 'password123'
            };

            const result = await apiModule.login(credentials);
            assert.ok(result);
            assert.ok(result.token);
            assert.ok(result.tenantId);
        });

        test('POST /api/auth/login rejects invalid credentials', async () => {
            const credentials = {
                email: 'test@salon.com',
                password: 'wrongpassword'
            };

            const result = await apiModule.login(credentials);
            assert.ok(result.error);
            assert.equal(result.status, 401);
        });

        test('POST /api/auth/logout invalidates session', async () => {
            const result = await apiModule.logout('test_token');
            assert.ok(result);
            assert.equal(result.success, true);
        });
    });

    describe('Webhook Routes', () => {
        test('POST /api/webhook/whatsapp processes WhatsApp webhook', async () => {
            const payload = {
                object: 'whatsapp_business_account',
                entry: [{ changes: [] }]
            };

            const result = await apiModule.handleWhatsAppWebhook(payload);
            assert.ok(result);
        });

        test('GET /api/webhook/whatsapp verifies webhook', () => {
            const params = {
                'hub.mode': 'subscribe',
                'hub.verify_token': 'test_token',
                'hub.challenge': 'challenge_123'
            };

            const result = apiModule.verifyWhatsAppWebhook(params);
            assert.equal(result, 'challenge_123');
        });
    });

    describe('Error Handling', () => {
        test('returns 404 for non-existent route', async () => {
            const result = await apiModule.handleNotFound();
            assert.equal(result.status, 404);
            assert.match(result.error, /not found/i);
        });

        test('returns 500 for server errors', async () => {
            const result = await apiModule.handleError(new Error('Test error'));
            assert.equal(result.status, 500);
        });

        test('validates tenant ID in requests', async () => {
            const result = await apiModule.getServices(null);
            assert.ok(result.error);
            assert.match(result.error, /tenant/i);
        });
    });

    describe('Rate Limiting', () => {
        test('limits requests per tenant', async () => {
            const tenantId = 'RATE_LIMIT_TEST';
            const requests = [];

            // Send 200 rapid requests
            for (let i = 0; i < 200; i++) {
                requests.push(apiModule.getServices(tenantId));
            }

            const results = await Promise.all(requests);
            const rateLimited = results.filter(r => r.status === 429);

            assert.ok(rateLimited.length > 0);
        });
    });
});