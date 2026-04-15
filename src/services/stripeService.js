"use strict";

let _stripe = null;
function getStripe() {
    if (!process.env.STRIPE_SECRET_KEY) {
        throw new Error('STRIPE_SECRET_KEY not set');
    }
    if (!_stripe) _stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    return _stripe;
}

/**
 * Create a Stripe Checkout Session for a plan subscription.
 */
async function createCheckoutSession({ planId, stripePriceId, email, ownerName, salonName, phone, successUrl, cancelUrl }) {
    const required = { planId, stripePriceId, email, successUrl, cancelUrl };
    for (const [key, val] of Object.entries(required)) {
        if (!val) throw new Error(`createCheckoutSession: missing required field "${key}"`);
    }
    const stripe = getStripe();
    const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        payment_method_types: ['card'],
        customer_email: email,
        line_items: [{ price: stripePriceId, quantity: 1 }],
        success_url: successUrl,
        cancel_url: cancelUrl,
        metadata: {
            plan_id: String(planId),
            owner_name: ownerName,
            salon_name: salonName,
            phone: String(phone || ''),
        },
        subscription_data: {
            metadata: {
                plan_id: String(planId),
                salon_name: salonName,
            },
        },
    });
    return session;
}

/**
 * Construct and verify a Stripe webhook event.
 */
function constructWebhookEvent(payload, signature) {
    if (!process.env.STRIPE_WEBHOOK_SECRET) {
        throw new Error('STRIPE_WEBHOOK_SECRET not set');
    }
    const stripe = getStripe();
    return stripe.webhooks.constructEvent(
        payload,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET
    );
}

module.exports = { createCheckoutSession, constructWebhookEvent };
