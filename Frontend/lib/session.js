const crypto = require('crypto');
const { singleSessionEnabled, getSessionTtlMs } = require('./device-config');

let activeSession = null;

function createSession({ meshUserId, username, password, email }) {
  if (!singleSessionEnabled()) {
    return { sessionId: null, meshUserId, username, email: email || null };
  }

  const sessionId = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  activeSession = {
    sessionId,
    meshUserId,
    username,
    email: email || null,
    password: password || null,
    clusterRoleConfirmed: false,
    userRoleConfirmed: false,
    userRole: null,
    createdAt: now,
    expiresAt: now + getSessionTtlMs(),
  };
  return sanitizeSession(activeSession);
}

function sanitizeSession(sess) {
  if (!sess) return null;
  const { password, ...safe } = sess;
  return { ...safe };
}

function getSessionRecord(sessionId) {
  if (!singleSessionEnabled() || !activeSession) return null;
  if (sessionId && activeSession.sessionId !== sessionId) return null;
  if (Date.now() > activeSession.expiresAt) {
    activeSession = null;
    return null;
  }
  return activeSession;
}

function getSession(sessionId) {
  return sanitizeSession(getSessionRecord(sessionId));
}

function clearSessionPassword(sessionId) {
  const sess = getSessionRecord(sessionId);
  if (!sess) return;
  delete sess.password;
}

function destroySession(sessionId) {
  if (!activeSession) return false;
  if (sessionId && activeSession.sessionId !== sessionId) return false;
  activeSession = null;
  return true;
}

function getActiveSession() {
  return getSession(activeSession?.sessionId);
}

function destroyAllSessions() {
  activeSession = null;
  return true;
}

function confirmClusterRole(sessionId) {
  const sess = getSessionRecord(sessionId);
  if (!sess) return false;
  sess.clusterRoleConfirmed = true;
  return true;
}

function isClusterRoleConfirmed(sessionId) {
  const sess = getSessionRecord(sessionId);
  return sess ? sess.clusterRoleConfirmed === true : false;
}

function confirmUserRole(sessionId, roleId) {
  const sess = getSessionRecord(sessionId);
  if (!sess) return false;
  sess.userRoleConfirmed = true;
  sess.userRole = roleId;
  return true;
}

function isUserRoleConfirmed(sessionId) {
  const sess = getSessionRecord(sessionId);
  return sess ? sess.userRoleConfirmed === true : false;
}

function getSessionUserRole(sessionId) {
  const sess = getSessionRecord(sessionId);
  return sess?.userRole || null;
}

module.exports = {
  createSession,
  getSession,
  getSessionRecord,
  clearSessionPassword,
  destroySession,
  destroyAllSessions,
  confirmClusterRole,
  isClusterRoleConfirmed,
  confirmUserRole,
  isUserRoleConfirmed,
  getSessionUserRole,
  getActiveSession,
};
