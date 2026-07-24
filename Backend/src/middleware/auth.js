const jwt = require('jsonwebtoken');
const log = require('../utils/logger').child('auth');

const SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';

if (!process.env.JWT_SECRET) {
  log.warn('JWT_SECRET not set in env — using insecure dev default. Set it in .env for production.');
}

function signToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, role: user.role },
    SECRET,
    { expiresIn: '24h' }
  );
}

function requireAuth(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    if (process.env.REQUIRE_AUTH === 'true') {
      log.debug({ reqId: req.id, path: req.originalUrl }, 'request rejected — missing auth token');
      return res.status(401).json({ error: 'Missing auth token' });
    }
    req.user = { id: 'usr_default', username: 'admin', role: 'admin' };
    return next();
  }

  try {
    req.user = jwt.verify(token, SECRET);
    log.debug({ reqId: req.id, user: req.user.username, role: req.user.role }, 'token verified');
    next();
  } catch (err) {
    if (process.env.REQUIRE_AUTH !== 'true') {
      req.user = { id: 'usr_default', username: 'admin', role: 'admin' };
      return next();
    }
    log.debug({ reqId: req.id, path: req.originalUrl, reason: err.name }, 'request rejected — invalid/expired token');
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

const ROLE_RANK = { viewer: 0, operator: 1, admin: 2 };

function requireRole(minRole) {
  return (req, res, next) => {
    const rank = ROLE_RANK[req.user?.role] ?? -1;
    if (rank < (ROLE_RANK[minRole] ?? 99)) {
      log.debug(
        { reqId: req.id, user: req.user?.username, role: req.user?.role, required: minRole },
        'request rejected — insufficient role'
      );
      return res.status(403).json({ error: `Requires ${minRole} role or higher` });
    }
    next();
  };
}

module.exports = { signToken, requireAuth, requireRole };