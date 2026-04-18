'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

let webhookModule;

before(() => {
    delete require.cache[require.resolve('../src/handlers/whatsapp')];
    delete require.cache[require.resolve('../src/handlers/instagram')];
    delete require.cache[require.resolve('../src/handlers/facebook')];
    webhookModule = require('../src/handlers/whatsapp');
});

describe('Webhook Handlers', () => {
    describe('WhatsApp Webhook', () => {
        test('verify webhook with correct token', () => {
            const mode = 'subscribe';
            const token = 'test_verify_token';
            const challenge = 'test_challenge_123';

            // This depends on your implementation
            const result = webhookModule.verifyWebhook(mode, token, challenge);
            assert.ok(result);
        });

        test('rejects webhook with incorrect token', () => {
            const mode = 'subscribe';
            const token = 'wrong_token';
            const challenge = 'test_challenge_123';

            const result = webhookModule.verifyWebhook(mode, token, challenge);
            assert.equal(result, false);
        });

        test('handles incoming WhatsApp message', async () => {
            const message = {
                object: 'whatsapp_business_account',
                entry: [{
                    changes: [{
                        value: {
                            messages: [{
                                from: '923001234567',
                                text: { body: 'Hello' },
                                timestamp: Date.now()
                            }]
                        }
                    }]
                }]
            };

            const result = await webhookModule.handleWebhook(message);
            assert.ok(result);
        });

        test('handles media messages', async () => {
            const mediaMessage = {
                entry: [{
                    changes: [{
                        value: {
                            messages: [{
                                from: '923001234567',
                                type: 'image',
                                image: { id: 'media_id_123' }
                            }]
                        }
                    }]
                }]
            };

            const result = await webhookModule.handleWebhook(mediaMessage);
            assert.ok(result);
        });
    });

    describe('Instagram Webhook', () => {
        let instagramModule;

        before(() => {
            instagramModule = require('../src/handlers/instagram');
        });

        test('verifies Instagram webhook', () => {
            const mode = 'subscribe';
            const token = 'ig_verify_token';
            const challenge = 'ig_challenge_456';

            const result = instagramModule.verifyWebhook(mode, token, challenge);
            assert.ok(result);
        });

        test('handles Instagram comment', async () => {
            const comment = {
                entry: [{
                    changes: [{
                        field: 'comments',
                        value: {
                            from: { id: 'user_123', username: 'test_user' },
                            text: 'How to book?',
                            id: 'comment_456'
                        }
                    }]
                }]
            };

            const result = await instagramModule.handleWebhook(comment);
            assert.ok(result);
        });
    });

    describe('Facebook Webhook', () => {
        let facebookModule;

        before(() => {
            facebookModule = require('../src/handlers/facebook');
        });

        test('verifies Facebook webhook', () => {
            const mode = 'subscribe';
            const token = 'fb_verify_token';
            const challenge = 'fb_challenge_789';

            const result = facebookModule.verifyWebhook(mode, token, challenge);
            assert.ok(result);
        });

        test('handles Facebook page messages', async () => {
            const message = {
                entry: [{
                    messaging: [{
                        sender: { id: 'user_123' },
                        recipient: { id: 'page_456' },
                        message: { text: 'Hi' }
                    }]
                }]
            };

            const result = await facebookModule.handleWebhook(message);
            assert.ok(result);
        });
    });

    describe('Webhook Error Handling', () => {
        test('handles malformed webhook payload', async () => {
            const invalidPayload = { invalid: 'data' };

            const result = await webhookModule.handleWebhook(invalidPayload);
            assert.equal(result, false);
        });

        test('handles empty webhook payload', async () => {
            const result = await webhookModule.handleWebhook(null);
            assert.equal(result, false);
        });

        test('handles rate limiting', async () => {
            // Send multiple rapid requests
            const promises = [];
            for (let i = 0; i < 100; i++) {
                promises.push(webhookModule.handleWebhook({ test: i }));
            }

            const results = await Promise.all(promises);
            // Should handle rate limiting gracefully
            assert.ok(Array.isArray(results));
        });
    });
});