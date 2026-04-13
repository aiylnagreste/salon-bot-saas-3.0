const { getDb } = require('../db/database');

function getBranches(tenantId) {
  try {
    return getDb().prepare(`SELECT * FROM ${tenantId}_branches ORDER BY number ASC`).all();
  } catch {
    return [];
  }
}

function getBranchesReply(tenantId) {
  const branches = getBranches(tenantId);
  let reply = '📍 *Our Branches*\n\n';
  for (const b of branches) {
    reply += `🏪 *${b.name}*\n`;
    reply += `📌 ${b.address}\n`;
    if (b.phone) reply += `📞 ${b.phone}\n`;
    reply += `🗺️ ${b.map_link}\n\n`;
  }
  reply += 'To book an appointment, type *book*!';
  return reply;
}

module.exports = { getBranchesReply, getBranches };