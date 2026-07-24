const os = require('os');
const { getDb } = require('./db');
const { listAuditLogs, listSecurityEvents } = require('./audit');
const { getPlatformState } = require('./platform-control');
const { listFlags } = require('./feature-flags');
const { getTenantAnalytics } = require('./tenants');

function getSystemMetrics() {
  const cpus = os.cpus();
  const load = os.loadavg();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;

  return {
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    uptimeSeconds: os.uptime(),
    cpu: {
      cores: cpus.length,
      model: cpus[0]?.model || 'unknown',
      load1m: load[0],
      load5m: load[1],
      load15m: load[2],
      usagePercent: Math.min(100, Math.round((load[0] / cpus.length) * 100)),
    },
    memory: {
      totalBytes: totalMem,
      usedBytes: usedMem,
      freeBytes: freeMem,
      usagePercent: Math.round((usedMem / totalMem) * 100),
    },
  };
}

function getDatabaseHealth() {
  const db = getDb();
  const started = Date.now();
  db.prepare('SELECT 1').get();
  const latencyMs = Date.now() - started;
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((r) => r.name);
  return {
    status: latencyMs < 100 ? 'healthy' : 'degraded',
    latencyMs,
    engine: 'sqlite',
    tables: tables.length,
    tableNames: tables,
  };
}

function computeHealthScore(metrics, dbHealth, platform) {
  let score = 100;
  if (metrics.memory.usagePercent > 90) score -= 25;
  else if (metrics.memory.usagePercent > 75) score -= 10;
  if (metrics.cpu.usagePercent > 90) score -= 20;
  else if (metrics.cpu.usagePercent > 75) score -= 8;
  if (dbHealth.status !== 'healthy') score -= 15;
  if (platform.emergencyLockdown) score -= 40;
  if (platform.maintenanceMode) score -= 10;
  return Math.max(0, Math.min(100, score));
}

function getHealthOverview() {
  const platform = getPlatformState();
  const metrics = getSystemMetrics();
  const database = getDatabaseHealth();
  const score = computeHealthScore(metrics, database, platform);

  return {
    score,
    status: score >= 85 ? 'healthy' : score >= 60 ? 'degraded' : 'critical',
    metrics,
    database,
    platform,
    timestamp: new Date().toISOString(),
  };
}

function getMasterOverview() {
  const platform = getPlatformState();
  const flags = listFlags();
  const tenants = getTenantAnalytics();
  const audit = listAuditLogs({ limit: 5 });
  const security = listSecurityEvents({ limit: 5 });
  const health = getHealthOverview();

  return {
    platform,
    health,
    tenants,
    featureFlags: {
      total: flags.length,
      enabled: flags.filter((f) => f.enabled).length,
    },
    recentAudit: audit.items,
    recentSecurityEvents: security.items,
  };
}

module.exports = {
  getSystemMetrics,
  getDatabaseHealth,
  getHealthOverview,
  getMasterOverview,
};
