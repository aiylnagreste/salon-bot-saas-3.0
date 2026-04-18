'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

let utils;

before(() => {
    delete require.cache[require.resolve('../src/utils/helpers')];
    utils = require('../src/utils/helpers');
});

describe('Utility Functions', () => {
    describe('Date Formatting', () => {
        test('formatDate returns YYYY-MM-DD', () => {
            const date = new Date(2024, 11, 25);
            const formatted = utils.formatDate(date);
            assert.equal(formatted, '2024-12-25');
        });

        test('formatTime returns HH:MM', () => {
            const date = new Date(2024, 11, 25, 14, 30);
            const formatted = utils.formatTime(date);
            assert.equal(formatted, '14:30');
        });

        test('getDayName returns correct day', () => {
            const date = new Date(2024, 11, 25); // Wednesday
            const dayName = utils.getDayName(date);
            assert.equal(dayName, 'Wednesday');
        });
    });

    describe('Phone Number Validation', () => {
        test('validates Pakistani phone numbers', () => {
            const validNumbers = [
                '+923001234567',
                '03001234567',
                '03121234567',
                '03451234567',
                '03331234567'
            ];

            for (const phone of validNumbers) {
                assert.ok(utils.isValidPakistaniPhone(phone));
            }
        });

        test('rejects invalid phone numbers', () => {
            const invalidNumbers = [
                '123',
                'abc',
                '+44123456789',
                '0300123456', // Too short
                '030012345678' // Too long
            ];

            for (const phone of invalidNumbers) {
                assert.ok(!utils.isValidPakistaniPhone(phone));
            }
        });

        test('normalizes phone numbers', () => {
            const testCases = [
                { input: '03001234567', expected: '+923001234567' },
                { input: '3001234567', expected: '+923001234567' },
                { input: '+923001234567', expected: '+923001234567' }
            ];

            for (const { input, expected } of testCases) {
                const normalized = utils.normalizePhone(input);
                assert.equal(normalized, expected);
            }
        });
    });

    describe('String Formatting', () => {
        test('capitalizes first letter', () => {
            const testCases = [
                { input: 'ahmad', expected: 'Ahmad' },
                { input: 'ALI', expected: 'Ali' },
                { input: 'john doe', expected: 'John doe' }
            ];

            for (const { input, expected } of testCases) {
                const result = utils.capitalizeFirst(input);
                assert.equal(result, expected);
            }
        });

        test('truncates long strings', () => {
            const longString = 'This is a very long string that needs truncation';
            const truncated = utils.truncate(longString, 20);
            assert.equal(truncated, 'This is a very long...');
        });

        test('slugifies strings', () => {
            const testCases = [
                { input: 'Hair Cut Service', expected: 'hair-cut-service' },
                { input: 'Premium & Luxury', expected: 'premium-luxury' },
                { input: '   Spaces   ', expected: 'spaces' }
            ];

            for (const { input, expected } of testCases) {
                const slug = utils.slugify(input);
                assert.equal(slug, expected);
            }
        });
    });

    describe('Price Formatting', () => {
        test('formats price with currency', () => {
            const testCases = [
                { price: 1500, currency: 'Rs.', expected: 'Rs. 1,500' },
                { price: 100, currency: '$', expected: '$ 100' },
                { price: 5000, currency: 'PKR', expected: 'PKR 5,000' }
            ];

            for (const { price, currency, expected } of testCases) {
                const formatted = utils.formatPrice(price, currency);
                assert.equal(formatted, expected);
            }
        });

        test('handles decimal prices', () => {
            const formatted = utils.formatPrice(99.99, '$');
            assert.equal(formatted, '$ 99.99');
        });
    });

    describe('Time Slot Generation', () => {
        test('generates time slots between hours', () => {
            const slots = utils.generateTimeSlots('09:00', '17:00', 60);
            assert.ok(slots.length > 0);
            assert.equal(slots[0], '09:00');
            assert.equal(slots[slots.length - 1], '16:00');
        });

        test('respects duration for slots', () => {
            const slots30min = utils.generateTimeSlots('09:00', '12:00', 30);
            const slots60min = utils.generateTimeSlots('09:00', '12:00', 60);

            assert.equal(slots30min.length, 6); // 09:00,09:30,10:00,10:30,11:00,11:30
            assert.equal(slots60min.length, 3); // 09:00,10:00,11:00
        });

        test('excludes booked slots', () => {
            const bookedSlots = ['10:00', '11:00'];
            const slots = utils.generateTimeSlots('09:00', '12:00', 60, bookedSlots);

            assert.ok(!slots.includes('10:00'));
            assert.ok(!slots.includes('11:00'));
            assert.ok(slots.includes('09:00'));
        });
    });

    describe('Object Utilities', () => {
        test('deep clones objects', () => {
            const original = { a: 1, b: { c: 2 } };
            const cloned = utils.deepClone(original);

            cloned.b.c = 3;

            assert.equal(original.b.c, 2);
            assert.equal(cloned.b.c, 3);
        });

        test('picks specific keys from object', () => {
            const obj = { id: 1, name: 'Test', password: 'secret', email: 'test@test.com' };
            const picked = utils.pick(obj, ['id', 'name', 'email']);

            assert.ok(picked.id);
            assert.ok(picked.name);
            assert.ok(picked.email);
            assert.ok(!picked.password);
        });

        test('omits specific keys from object', () => {
            const obj = { id: 1, name: 'Test', password: 'secret', email: 'test@test.com' };
            const omitted = utils.omit(obj, ['password']);

            assert.ok(omitted.id);
            assert.ok(omitted.name);
            assert.ok(omitted.email);
            assert.ok(!omitted.password);
        });
    });

    describe('Validation Helpers', () => {
        test('validates email format', () => {
            const validEmails = ['test@test.com', 'user@domain.co.uk', 'name+tag@example.com'];
            const invalidEmails = ['invalid', 'missing@dot', '@example.com'];

            for (const email of validEmails) {
                assert.ok(utils.isValidEmail(email));
            }

            for (const email of invalidEmails) {
                assert.ok(!utils.isValidEmail(email));
            }
        });

        test('validates URL format', () => {
            const validUrls = ['https://example.com', 'http://test.com/path', 'https://sub.domain.co.uk'];
            const invalidUrls = ['not-a-url', 'ftp://invalid', 'http://'];

            for (const url of validUrls) {
                assert.ok(utils.isValidUrl(url));
            }

            for (const url of invalidUrls) {
                assert.ok(!utils.isValidUrl(url));
            }
        });

        test('validates date range', () => {
            const start = '2024-12-25';
            const end = '2024-12-30';

            assert.ok(utils.isValidDateRange(start, end));
            assert.ok(!utils.isValidDateRange(end, start));
        });
    });

    describe('Random Generators', () => {
        test('generates unique ID', () => {
            const id1 = utils.generateUniqueId();
            const id2 = utils.generateUniqueId();

            assert.notEqual(id1, id2);
            assert.ok(id1.length > 0);
        });

        test('generates booking reference', () => {
            const ref = utils.generateBookingReference();
            assert.match(ref, /^BK-\d{8}-\d{4}$/);
        });

        test('generates OTP', () => {
            const otp = utils.generateOTP(6);
            assert.match(otp, /^\d{6}$/);
        });
    });
});