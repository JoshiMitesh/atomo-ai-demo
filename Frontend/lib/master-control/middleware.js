const session = require('../session');
const { ensureDefaultAdmin, getUserRole, requirePermission } = require('./permissions');
const { isReadOnly, isApiAllowed, getPlatformState } = require('./platform-control');
const { recordSecurityEvent } = require('./audit');

function resolveSession(req) {
  const sessionId =
    req.body?.sessionId ||
    req.query?.sessionId ||
    req.headers['x-session-id'];
  if (sessionId) {
    const sess = session.getSessionRecord(sessionId);
    if (sess) return sess;
  }
  return session.getSessionRecord(session.getActiveSession()?.sessionId);
}

function getRequestMeta(req) {
  return {
    ipAddress: req.ip || req.headers['x-forwarded-for'] || req.socket?.remoteAddress,
    userAgent: req.headers['user-agent'] || null,
  };
}

function requireMasterAuth(permission) {
  return (req, res, next) => {
    if (!isApiAllowed()) {
      const state = getPlatformState();
      return res.status(503).json({
        error: state.emergencyLockdown
          ? 'Platform is in emergency lockdown.'
          : 'Platform APIs are currently disabled.',
        platform: state,
      });
    }

    const sess = resolveSession(req);
    if (!sess) {
      return res.status(401).json({ error: 'Authentication required.' });
    }

    ensureDefaultAdmin(sess.meshUserId, sess.username);
    req.masterSession = sess;
    req.requestMeta = getRequestMeta(req);

    try {
      requirePermission(sess.meshUserId, permission);
    } catch (err) {
      recordSecurityEvent({
        eventType: 'permission_denied',
        severity: 'warning',
        actorUserId: sess.meshUserId,
        description: `Denied ${permission} for ${sess.username}`,
        metadata: { path: req.path, method: req.method },
        ipAddress: req.requestMeta.ipAddress,
      });
      return res.status(err.status || 403).json({ error: err.message });
    }

    return next();
  };
}

function blockIfReadOnly(req, res, next) {
  if (!isReadOnly()) return next();
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  return res.status(423).json({
    error: 'Platform is in read-only or feature-freeze mode. Mutations are disabled.',
    platform: getPlatformState(),
  });
}

function attachMasterContext(req, _res, next) {
  const sess = resolveSession(req);
  if (sess) {
    ensureDefaultAdmin(sess.meshUserId, sess.username);
    req.masterSession = sess;
    req.masterRole = getUserRole(sess.meshUserId);
    req.requestMeta = getRequestMeta(req);
  }
  next();
}

module.exports = {
  resolveSession,
  getRequestMeta,
  requireMasterAuth,
  blockIfReadOnly,
  attachMasterContext,
};
