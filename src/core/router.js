const { detectIntent } = require('./intent');
const { getSession, setSession, clearSession, isSessionExpired } = require('./session');
const { getPricesReply, getServiceDetail, getServiceListReply } = require('../replies/prices');
const { getDealsReply } = require('../replies/deals');
const { getBranchesReply } = require('../replies/branches');
const { handleBookingStep, handleCancellationFlow, handleRescheduleFlow } = require('../replies/booking');

const FALLBACK_MESSAGE =
  "Hi! I'm here to help. You can ask me about:\n\n" +
  '💰 *Prices* — type "prices" or "how much"\n' +
  '✨ *Service Details* — type "tell me about" or "what is"\n' +
  '🎁 *Deals* — type "offers" or "deals"\n' +
  '📍 *Location* — type "where" or "branches"\n' +
  '📅 *Booking* — type "book" or "appointment"\n\n' +
  '❌ Cancel your booking anytime by typing "cancel"\n' +
  '🔄 Reschedule by typing "reschedule"\n\n' +
  'Our team is always happy to help!';

async function routeMessage(userId, messageText, platform, tenantId) {
  // Pass tenantId to getSession
  let session = getSession(userId, tenantId);
  console.log('[BOOKING ROUTER] userId:', userId, '| tenant:', tenantId, '| platform:', platform, '| text:', JSON.stringify(messageText), '| sessionState:', session?.state || 'none');

  // Check session expiry
  if (session && isSessionExpired(session, 5)) {
    clearSession(userId, tenantId);
    session = null;
    return "⏰ Your booking session has expired due to inactivity. Let me know if you want to start again!";
  }

  // Step 1 — always detect intent first
  const result = await detectIntent(messageText);
  const intent = typeof result === 'object' ? result.intent : result;
  const term = typeof result === 'object' ? result.term : null;

  // Step 2 — handle cancellation and reschedule at ANY time (highest priority)
  if (intent === 'CANCEL_BOOKING') {
    return handleCancellationFlow(userId, messageText, session, platform, tenantId);
  }

  if (intent === 'RESCHEDULE') {
    return handleRescheduleFlow(userId, messageText, session, platform, tenantId);
  }

  if (intent === 'CANCEL') {
    clearSession(userId, tenantId);
    return "✅ Your booking process has been cancelled. If you need anything else, I'm here to help!";
  }

  // Step 3 — If user is inside booking flow & not canceling → continue booking flow
  if (session && session.state && session.state.startsWith('ASK_')) {
    return handleBookingStep(userId, messageText, session, platform, tenantId);
  }

  // Step 4 — Normal intent routing (pass tenantId to all reply functions)
  switch (intent) {
    case 'PRICE':
      return getPricesReply(tenantId);

    case 'SERVICE_LIST':
      return getServiceListReply(tenantId);

    case 'SERVICE_DETAIL':
      return getServiceDetail(term, tenantId);

    case 'DEALS':
      return getDealsReply(tenantId);

    case 'BRANCH':
      return getBranchesReply(tenantId);

    case 'BOOKING':
      return handleBookingStep(userId, messageText, null, platform, tenantId);

    default:
      return FALLBACK_MESSAGE;
  }
}

module.exports = { routeMessage };