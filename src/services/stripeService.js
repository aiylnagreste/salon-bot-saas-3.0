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
        expand: ['subscription'],
        customer_email: email,
        line_items: [{ price: stripePriceId, quantity: 1 }],
        success_url: successUrl,
        cancel_url: cancelUrl,
        metadata: {
            plan_id: String(planId),
            owner_name: ownerName,
            salon_name: salonName,
            phone: String(phone || ''),
            email,
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
 * Create a Stripe Checkout Session for plan upgrades (with customer ID)
 */
async function createUpgradeCheckoutSession({ planId, stripePriceId, email, ownerName, salonName, phone, successUrl, cancelUrl, stripeCustomerId, tenantId }) {
    const required = { planId, stripePriceId, email, successUrl, cancelUrl };
    for (const [key, val] of Object.entries(required)) {
        if (!val) throw new Error(`createUpgradeCheckoutSession: missing required field "${key}"`);
    }
    const stripe = getStripe();

    const sessionParams = {
        mode: 'subscription',
        payment_method_types: ['card'],
        expand: ['subscription'],
        line_items: [{ price: stripePriceId, quantity: 1 }],
        success_url: successUrl,
        cancel_url: cancelUrl,
        metadata: {
            plan_id: String(planId),
            owner_name: ownerName,
            salon_name: salonName,
            phone: String(phone || ''),
            email,
            is_upgrade: 'true',
            action: 'upgrade',           // ✅ Add this
            tenantId: tenantId,          // ✅ Add this - the tenant ID
            newPlanId: String(planId),   // ✅ Add this
            oldPlanId: 'none',           // ✅ Add this (will be updated in upgrade route)
        },
        subscription_data: {
            metadata: {
                plan_id: String(planId),
                salon_name: salonName,
                is_upgrade: 'true',
            },
        },
    };

    // Use customer ID if provided, otherwise use email
    if (stripeCustomerId) {
        sessionParams.customer = stripeCustomerId;
    } else {
        sessionParams.customer_email = email;
    }

    const session = await stripe.checkout.sessions.create(sessionParams);
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

async function retrieveSubscription(subscriptionId) {
    const sub = await getStripe().subscriptions.retrieve(subscriptionId);

    // ✅ Stripe SDK v11+ (you're on v22) moved period dates to current_period.start/end
    // Normalize to flat fields so all existing callers work unchanged
    sub.current_period_start = sub.current_period?.start ?? null;
    sub.current_period_end = sub.current_period?.end ?? null;

    return sub;
}

module.exports = { 
    createCheckoutSession, 
    constructWebhookEvent, 
    retrieveSubscription,
    createUpgradeCheckoutSession  // Export the new function
};