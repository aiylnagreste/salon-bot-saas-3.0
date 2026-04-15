"use strict";

function getStripe() {
    if (!process.env.STRIPE_SECRET_KEY) {
        throw new Error('STRIPE_SECRET_KEY not set');
    }
    const Stripe = require('stripe');
    return Stripe(process.env.STRIPE_SECRET_KEY);
}

/**
 * Create a Stripe Checkout Session for a plan subscription.
 */
async function createCheckoutSession({ planId, stripePriceId, email, ownerName, salonName, phone, successUrl, cancelUrl, registrationData }) {
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
            phone,
            registration_data: registrationData || '',
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
    const stripe = getStripe();
    return stripe.webhooks.constructEvent(
        payload,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET
    );
}

module.exports = { createCheckoutSession, constructWebhookEvent };
