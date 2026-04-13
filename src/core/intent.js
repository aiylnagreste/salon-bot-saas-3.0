const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are a classifier for a beauty salon chatbot.
Classify the user's message as one of: PRICE, DEALS, BOOKING, BRANCH, SERVICE_DETAIL, UNKNOWN.

- PRICE: asking about service prices, costs, how much something costs, full price list
- DEALS: asking about offers, promotions, discounts, specials
- BOOKING: wants to book, schedule, make an appointment, reserve a slot
- BRANCH: asking about location, address, directions, where the salon is
- SERVICE_LIST: user wants to know what services are available, what do you offer, what treatments do you have, list of services (WITHOUT asking about prices or specific details)
- SERVICE_DETAIL: asking about details, description, or what is included in a SPECIFIC named service or package (e.g. "tell me about bridal package 1", "what's included in hydrafacial deal", "details about keratin treatment")
- CANCEL_BOOKING: user wants to cancel an existing booking (e.g., "cancel my appointment", "I want to cancel")
- RESCHEDULE: user wants to change appointment time/date (e.g., "reschedule my booking", "change my appointment time")
- CANCEL: user wants to cancel the CURRENT conversation or booking flow (e.g., "cancel", "never mind", "forget it", "stop", "cancel that")
- UNKNOWN: anything else

If the intent is SERVICE_DETAIL, reply in this exact format:
SERVICE_DETAIL|<extracted service name>

For example:
User: "tell me about bridal makeup package 1"
Reply: SERVICE_DETAIL|bridal makeup package 1

User: "what does the hydrafacial deal include"
Reply: SERVICE_DETAIL|hydrafacial deal

For all other intents, reply with ONLY the single category word, nothing else.`;

async function detectIntent(message) {
  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 20,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: message }],
    });

    const raw = response.content[0].text.trim();

    if (raw.startsWith('SERVICE_DETAIL|')) {
      const term = raw.split('|')[1]?.trim();
      return term ? { intent: 'SERVICE_DETAIL', term } : 'UNKNOWN';
    }


    const validIntents = [
      'PRICE',
      'DEALS',
      'BOOKING',
      'BRANCH',
      'SERVICE_LIST',
      'SERVICE_DETAIL',
      'CANCEL_BOOKING',
      'RESCHEDULE',
      'CANCEL',
      'UNKNOWN'
    ];

    const intent = raw.toUpperCase();
    return validIntents.includes(intent) ? intent : 'UNKNOWN';
  } catch (err) {
    console.error('[intent] Claude API error:', err.message);
    return 'UNKNOWN';
  }
}

module.exports = { detectIntent };