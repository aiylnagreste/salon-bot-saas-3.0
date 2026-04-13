const { getDb } = require('../db/database');

function getDealsReply(tenantId) {
  try {
    const db = getDb();
    const deals = db.prepare(`
      SELECT title, description 
      FROM ${tenantId}_deals 
      WHERE active = 1 
      ORDER BY id
    `).all();

    if (!deals.length) {
      return "There are no active deals at the moment. Stay tuned — we regularly update our offers!\n\nType *prices* to see our full price list.";
    }

    let reply = '🎁 *Current Deals & Offers*\n\n';
    for (const deal of deals) {
      reply += `✨ *${deal.title}*\n${deal.description}\n\n`;
    }
    reply += 'To book, just type *book*!';
    return reply;
  } catch (err) {
    console.error('[deals] DB error:', err.message);
    return 'Sorry, I could not load deals right now. Please try again shortly.';
  }
}

module.exports = { getDealsReply };