const { getDb } = require('../db/database');

function getPricesReply(tenantId) {
  try {
    const db = getDb();
    const services = db.prepare(`
      SELECT name, price, description, branch 
      FROM ${tenantId}_services 
      ORDER BY branch, name
    `).all();

    if (!services.length) {
      return "We're updating our price list. Please contact us directly for current prices!";
    }

    // Group by branch
    const branches = {};
    for (const s of services) {
      const key = s.branch || 'All Branches';
      if (!branches[key]) branches[key] = [];
      branches[key].push(s);
    }

    let reply = '💅 *Our Services & Prices*\n\n';
    for (const [branch, items] of Object.entries(branches)) {
      reply += `📍 *${branch}*\n`;
      for (const item of items) {
        reply += `  • *${item.name}* — ${item.price}\n`;
      }
      reply += '\n';
    }
    reply += 'To book an appointment, just type *book*!';
    return reply;
  } catch (err) {
    console.error('[prices] DB error:', err.message);
    return 'Sorry, I could not load prices right now. Please try again shortly.';
  }
}

function getServiceDetail(name, tenantId) {
  try {
    const db = getDb();
    const service = db.prepare(
      `SELECT * FROM ${tenantId}_services WHERE LOWER(name) LIKE ?`
    ).get(`%${name.toLowerCase()}%`);

    if (!service) return "Sorry, I couldn't find that service. Type *prices* to see all services.";

    let reply = `✨ *${service.name}*\n`;
    reply += `💰 *Price:* ${service.price}\n`;
    reply += `📍 *Branch:* ${service.branch}\n`;
    if (service.description) {
      reply += `\n📋 *Includes:*\n${service.description.split('·').map(s => `  • ${s.trim()}`).join('\n')}`;
    }
    reply += `\n\nTo book, type *book*!`;
    return reply;
  } catch (err) {
    console.error('[service-detail] DB error:', err.message);
    return 'Sorry, could not load service details right now.';
  }
}

function getServiceListReply(tenantId) {
  try {
    const db = getDb();
    const services = db.prepare(`
      SELECT name, branch 
      FROM ${tenantId}_services 
      ORDER BY branch, name
    `).all();

    if (!services.length) {
      return "We're updating our service list. Please contact us directly!";
    }

    const branches = {};
    for (const s of services) {
      const key = s.branch || 'All Branches';
      if (!branches[key]) branches[key] = [];
      branches[key].push(s.name);
    }

    let reply = '💅 *Our Services*\n\n';
    for (const [branch, names] of Object.entries(branches)) {
      reply += `📍 *${branch}*\n`;
      for (const name of names) {
        reply += `  • ${name}\n`;
      }
      reply += '\n';
    }
    reply += 'Type *prices* to see full pricing.\n';
    reply += 'Type the service name for full details.\n';
    reply += 'Type *book* to make an appointment!';
    return reply;
  } catch (err) {
    console.error('[service-list] DB error:', err.message);
    return 'Sorry, could not load services right now.';
  }
}

module.exports = { getPricesReply, getServiceDetail, getServiceListReply };