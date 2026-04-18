// In-memory session store for stateful booking conversations

const SESSION_TTL_MS = 10 * 60 * 1000; // 10 minutes

const sessions = new Map(); // Map(tenantId -> Map(userId -> session))

function getSession(userId, tenantId) {
  const tenantSessions = sessions.get(tenantId);
  if (!tenantSessions) return null;

  const entry = tenantSessions.get(userId);
  if (!entry) return null;

  if (Date.now() - entry.updatedAt > SESSION_TTL_MS) {
    tenantSessions.delete(userId);
    return null;
  }
  return entry.data;
}

function setSession(userId, tenantId, newData) {
  if (userId === undefined || userId === null) throw new Error('setSession: userId must not be null/undefined');
  if (tenantId === undefined || tenantId === null) throw new Error('setSession: tenantId must not be null/undefined');

  if (!sessions.has(tenantId)) {
    sessions.set(tenantId, new Map());
  }

  const tenantSessions = sessions.get(tenantId);
  const prev = tenantSessions.get(userId)?.data || {};

  tenantSessions.set(userId, {
    data: { ...prev, ...newData, lastUpdated: Date.now() },
    updatedAt: Date.now(),
  });
}

function clearSession(userId, tenantId) {
  const tenantSessions = sessions.get(tenantId);
  if (tenantSessions) {
    tenantSessions.delete(userId);
  }
}
// isSessionExpired checks data.lastUpdated (set by setSession above).

function isSessionExpired(session, minutes = 10) {
  if (!session || !session.lastUpdated) return true;
  return Date.now() - session.lastUpdated > minutes * 60 * 1000;
}

// Prune expired sessions every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [tenantId, tenantSessions] of sessions.entries()) {
    for (const [userId, entry] of tenantSessions.entries()) {
      if (now - entry.updatedAt > SESSION_TTL_MS) {
        tenantSessions.delete(userId);
      }
    }
    if (tenantSessions.size === 0) sessions.delete(tenantId);
  }
}, 5 * 60 * 1000);

module.exports = { getSession, setSession, clearSession, isSessionExpired };

