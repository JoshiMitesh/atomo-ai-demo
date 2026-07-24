const express = require('express');
const session = require('../session');
const deviceProfile = require('../device-profile');
const { writeAudit, listAuditLogs, listSecurityEvents } = require('./audit');
const { getPlatformState, updatePlatformState } = require('./platform-control');
const { listFlags, upsertFlag } = require('./feature-flags');
const {
  getActiveConfig,
  getConfigHistory,
  setConfigValue,
  rollbackConfig,
} = require('./config-store');
const {
  ensureDefaultTenant,
  listTenants,
  createTenant,
  updateTenantStatus,
  getTenantAnalytics,
} = require('./tenants');
const { listRoles, getUserRole } = require('./permissions');
const { getHealthOverview, getMasterOverview } = require('./health');
const { requireMasterAuth, blockIfReadOnly } = require('./middleware');

const router = express.Router();

router.use(blockIfReadOnly);

router.get('/overview', requireMasterAuth('platform.read'), (_req, res) => {
  res.json(getMasterOverview());
});

router.get('/platform', requireMasterAuth('platform.read'), (_req, res) => {
  res.json(getPlatformState());
});

router.patch('/platform', requireMasterAuth('platform.write'), (req, res) => {
  const { previous, current } = updatePlatformState(req.body, req.masterSession.username);
  writeAudit({
    actorUserId: req.masterSession.meshUserId,
    actorUsername: req.masterSession.username,
    action: 'platform.update',
    resourceType: 'platform_state',
    resourceId: 'global',
    oldValue: previous,
    newValue: current,
    ...req.requestMeta,
  });
  res.json(current);
});

router.post('/platform/force-logout', requireMasterAuth('platform.write'), (req, res) => {
  session.destroyAllSessions();
  writeAudit({
    actorUserId: req.masterSession.meshUserId,
    actorUsername: req.masterSession.username,
    action: 'sessions.invalidate_all',
    resourceType: 'session',
    resourceId: 'all',
    newValue: { forced: true },
    ...req.requestMeta,
  });
  res.json({ success: true, message: 'All sessions invalidated.' });
});

router.get('/feature-flags', requireMasterAuth('flags.read'), (_req, res) => {
  res.json({ items: listFlags() });
});

router.put('/feature-flags', requireMasterAuth('flags.write'), (req, res) => {
  const flag = upsertFlag(req.body, req.masterSession.username);
  writeAudit({
    actorUserId: req.masterSession.meshUserId,
    actorUsername: req.masterSession.username,
    action: 'feature_flag.upsert',
    resourceType: 'feature_flag',
    resourceId: flag.id,
    newValue: flag,
    ...req.requestMeta,
  });
  res.json(flag);
});

router.get('/config', requireMasterAuth('config.read'), (_req, res) => {
  res.json(getActiveConfig());
});

router.get('/config/:category/:key/history', requireMasterAuth('config.read'), (req, res) => {
  const history = getConfigHistory(req.params.category, req.params.key, req.query.environment);
  res.json({ items: history });
});

router.put('/config/:category/:key', requireMasterAuth('config.write'), (req, res) => {
  const { value, changeNote, environment } = req.body;
  const entryId = setConfigValue(req.params.category, req.params.key, value, {
    environment,
    createdBy: req.masterSession.username,
    changeNote,
  });
  writeAudit({
    actorUserId: req.masterSession.meshUserId,
    actorUsername: req.masterSession.username,
    action: 'config.update',
    resourceType: 'config',
    resourceId: `${req.params.category}.${req.params.key}`,
    newValue: value,
    metadata: { entryId, changeNote },
    ...req.requestMeta,
  });
  res.json(getActiveConfig(environment));
});

router.post('/config/:category/:key/rollback', requireMasterAuth('config.write'), (req, res) => {
  const { version, environment } = req.body;
  rollbackConfig(req.params.category, req.params.key, version, {
    environment,
    createdBy: req.masterSession.username,
  });
  writeAudit({
    actorUserId: req.masterSession.meshUserId,
    actorUsername: req.masterSession.username,
    action: 'config.rollback',
    resourceType: 'config',
    resourceId: `${req.params.category}.${req.params.key}`,
    newValue: { version },
    ...req.requestMeta,
  });
  res.json(getActiveConfig(environment));
});

router.get('/tenants', requireMasterAuth('tenants.read'), (_req, res) => {
  res.json({ items: listTenants(), analytics: getTenantAnalytics() });
});

router.post('/tenants', requireMasterAuth('tenants.write'), (req, res) => {
  const tenant = createTenant(req.body, req.masterSession.meshUserId);
  writeAudit({
    actorUserId: req.masterSession.meshUserId,
    actorUsername: req.masterSession.username,
    action: 'tenant.create',
    resourceType: 'tenant',
    resourceId: tenant.id,
    newValue: tenant,
    ...req.requestMeta,
  });
  res.status(201).json(tenant);
});

router.patch('/tenants/:id/status', requireMasterAuth('tenants.write'), (req, res) => {
  const tenant = updateTenantStatus(req.params.id, req.body.status);
  if (!tenant) return res.status(404).json({ error: 'Tenant not found.' });
  writeAudit({
    actorUserId: req.masterSession.meshUserId,
    actorUsername: req.masterSession.username,
    action: 'tenant.status_update',
    resourceType: 'tenant',
    resourceId: tenant.id,
    newValue: { status: tenant.status },
    ...req.requestMeta,
  });
  res.json(tenant);
});

router.get('/roles', requireMasterAuth('platform.read'), (_req, res) => {
  res.json({ items: listRoles() });
});

router.get('/me', requireMasterAuth('platform.read'), (req, res) => {
  const profile = deviceProfile.getProfile();
  res.json({
    user: {
      userId: req.masterSession.meshUserId,
      username: req.masterSession.username,
      email: req.masterSession.email,
    },
    role: getUserRole(req.masterSession.meshUserId),
    profile,
  });
});

router.get('/audit', requireMasterAuth('audit.read'), (req, res) => {
  const limit = parseInt(req.query.limit || '50', 10);
  const offset = parseInt(req.query.offset || '0', 10);
  res.json(
    listAuditLogs({
      limit,
      offset,
      resourceType: req.query.resourceType,
      actorUserId: req.query.actorUserId,
    })
  );
});

router.get('/security/events', requireMasterAuth('security.read'), (req, res) => {
  const limit = parseInt(req.query.limit || '50', 10);
  const offset = parseInt(req.query.offset || '0', 10);
  res.json(
    listSecurityEvents({
      limit,
      offset,
      severity: req.query.severity,
    })
  );
});

router.get('/health', requireMasterAuth('monitoring.read'), (_req, res) => {
  res.json(getHealthOverview());
});

module.exports = router;
