const express = require('express');
const router = express.Router();
const { signToken } = require('../middleware/auth');   // ← adjust path if needed
const log = require('../utils/logger').child('auth');

// POST /api/auth/login
router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  // Never log the password itself, even at debug level.
  log.debug({ reqId: req.id, username }, 'login attempt');

  if (username === 'admin' && password === 'admin123') {
    const user = { id: 1, username: 'admin', role: 'admin' };
    log.info({ reqId: req.id, username, role: user.role }, 'login succeeded');
    return res.json({
      success: true,
      token: signToken(user),
      user
    });
  }

  if (username === 'viewer' && password === 'viewer123') {
    const user = { id: 2, username: 'viewer', role: 'viewer' };
    log.info({ reqId: req.id, username, role: user.role }, 'login succeeded');
    return res.json({
      success: true,
      token: signToken(user),
      user
    });
  }

  log.warn({ reqId: req.id, username }, 'login failed — invalid credentials');
  res.status(401).json({ error: 'Invalid credentials' });
});

// GET /api/auth/me
router.get('/me', (req, res) => {
  // This will be protected by requireAuth middleware later
  res.json({ user: req.user || { id: 1, username: 'admin', role: 'admin' } });
});

module.exports = router;