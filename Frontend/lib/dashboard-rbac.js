/**
 * Dashboard RBAC — roles match product spec §5.2 User Roles.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { getDeviceBindingDbPath } = require('./device-config');

const ROLES = [
  {
    id: 'owner',
    name: 'Owner',
    description:
      'Full control over device, users, licenses, models, cloud sync, billing, and factory reset.',
    permissions: ['*'],
  },
  {
    id: 'admin',
    name: 'Admin',
    description:
      'Can add cameras, configure AI models, manage alerts, view reports, and manage operators.',
    permissions: [
      'dashboard.read',
      'detection.view',
      'detection.control',
      'cameras.read',
      'cameras.write',
      'live.view',
      'models.read',
      'models.write',
      'alerts.manage',
      'alerts.ack',
      'reports.read',
      'users.manage',
      'settings.read',
    ],
  },
  {
    id: 'operator',
    name: 'Operator',
    description:
      'Can monitor dashboard, view camera feeds, acknowledge alerts, and export limited reports.',
    permissions: [
      'dashboard.read',
      'detection.view',
      'cameras.read',
      'live.view',
      'alerts.ack',
      'reports.limited',
    ],
  },
  {
    id: 'viewer',
    name: 'Viewer',
    description: 'Can only view dashboard and camera status.',
    permissions: ['dashboard.read', 'cameras.read'],
  },
  {
    id: 'maintenance_engineer',
    name: 'Maintenance Engineer',
    description:
      'Can access logs, device health, OTA, diagnostics, and system-level configuration.',
    permissions: [
      'dashboard.read',
      'health.read',
      'logs.read',
      'ota.manage',
      'diagnostics',
      'system.config',
      'settings.read',
      'settings.write',
    ],
  },
  {
    id: 'developer',
    name: 'Developer',
    description:
      'Can upload custom AI models, configure inference pipeline, test model output, and manage APIs.',
    permissions: [
      'dashboard.read',
      'detection.view',
      'detection.control',
      'cameras.read',
      'live.view',
      'models.read',
      'models.write',
      'models.test',
      'pipeline.config',
      'api.manage',
      'settings.read',
    ],
  },
];

/** Sidebar nav id → required permission */
const NAV_PERMISSIONS = {
  overview: 'dashboard.read',
  person: 'detection.view',
  'fire-smoke': 'detection.view',
  face: 'detection.view',
  safety: 'detection.view',
  'ai-models': 'models.read',
  'alert-configuration': 'alerts.manage',
  settings: 'settings.read',
  'health-check': 'health.read',
};

/** Browser page paths → required permission */
const PAGE_PERMISSIONS = {
  '/overview': 'dashboard.read',
  '/alert-configuration': 'alerts.manage',
  '/settings': 'settings.read',
  '/detection/person': 'detection.view',
  '/detection/fire-smoke': 'detection.view',
  '/detection/face': 'detection.view',
  '/detection/safety': 'detection.view',
  '/dashboard': 'dashboard.read',
};

/** Exact or prefix API rules */
const API_RULES = [
  { match: /^\/api\/session$/, permission: null },
  { match: /^\/api\/logout$/, permission: null },
  { match: /^\/api\/user-role$/, permission: null },
  { match: /^\/api\/cluster-role$/, permission: null },
  { match: /^\/api\/overview/, permission: 'dashboard.read' },
  { match: /^\/api\/system-stats/, permission: 'dashboard.read' },
  { match: /^\/api\/live-metrics/, permission: 'dashboard.read' },

  { method: 'GET', match: /^\/api\/cameras(\/|$)/, permission: 'cameras.read' },
  { method: 'POST', match: /^\/api\/cameras(\/|$)/, permission: 'cameras.write' },
  { method: 'PATCH', match: /^\/api\/cameras(\/|$)/, permission: 'cameras.write' },
  { method: 'PUT', match: /^\/api\/cameras(\/|$)/, permission: 'cameras.write' },
  { method: 'DELETE', match: /^\/api\/cameras(\/|$)/, permission: 'cameras.write' },

  { match: /^\/api\/detection\/[^/]+\/export/, permissions: ['reports.read', 'reports.limited'] },
  { method: 'GET', match: /^\/api\/detection\//, permission: 'detection.view' },
  { method: 'POST', match: /^\/api\/detection\/[^/]+\/inference/, permission: 'detection.control' },
  {
    method: 'POST',
    match: /^\/api\/detection\/(?:person|face)\/live\/[^/]+\/(?:start|stop|config|select|prewarm|resync)/,
    permission: 'detection.control',
  },
  { method: 'POST', match: /^\/api\/detection\/(?:person|face)\/start-all/, permission: 'detection.control' },
  { method: 'PATCH', match: /^\/api\/detection\//, permission: 'detection.control' },
  { method: 'GET', match: /^\/api\/detection\/(?:person|face)\/live\/[^/]+\/frame/, permission: 'detection.view' },
  { match: /^\/api\/detection\/events\//, permission: 'detection.view' },

  { match: /^\/api\/alert-configuration/, permission: 'alerts.manage' },

  {
    method: 'POST',
    match: /^\/api\/face\/alerts\/.+\/acknowledge/,
    permissions: ['alerts.ack', 'alerts.manage'],
  },
  {
    method: 'POST',
    match: /^\/api\/face\/alerts\/bulk-acknowledge/,
    permissions: ['alerts.ack', 'alerts.manage'],
  },
  {
    method: 'GET',
    match: /^\/api\/face\/alerts/,
    permissions: ['alerts.ack', 'alerts.manage', 'detection.view'],
  },
  { method: 'POST', match: /^\/api\/face\/persons/, permission: 'models.write' },
  { method: 'PATCH', match: /^\/api\/face\/persons/, permission: 'models.write' },
  { method: 'DELETE', match: /^\/api\/face\/persons/, permission: 'models.write' },
  { method: 'POST', match: /^\/api\/face\/.*enroll/, permission: 'models.write' },
  { match: /^\/api\/face\//, permission: 'detection.view' },

  { match: /^\/api\/master\//, permission: 'system.config' },
];

let db;

function getDb() {
  if (db) return db;
  const dbPath = getDeviceBindingDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_dashboard_roles (
      mesh_user_id TEXT PRIMARY KEY,
      role_id TEXT NOT NULL,
      assigned_at INTEGER NOT NULL
    );
  `);
  return db;
}

const MASTER_ROLE_IDS = ['admin', 'viewer'];
const STANDALONE_DEFAULT_ROLE_ID = 'admin';

/** Master-node access must match role names: Admin = full control, Viewer = read-only monitoring. */
const MASTER_ROLE_ACCESS = {
  admin: {
    name: 'Admin',
    description:
      'Can add cameras, configure AI models, manage alerts, view reports, and manage operators.',
    permissions: [
      'dashboard.read',
      'detection.view',
      'detection.control',
      'cameras.read',
      'cameras.write',
      'live.view',
      'models.read',
      'models.write',
      'models.test',
      'alerts.manage',
      'alerts.ack',
      'reports.read',
      'users.manage',
      'settings.read',
      'settings.write',
      'health.read',
      'logs.read',
      'system.config',
      'platform.read',
      'platform.write',
      'api.manage',
    ],
  },
  viewer: {
    name: 'Viewer',
    description: 'Can only view dashboard and camera status.',
    permissions: ['dashboard.read', 'cameras.read'],
  },
};

function normalizeClusterMode(clusterMode) {
  return String(clusterMode || '').trim().toLowerCase();
}

function resolveClusterMode(clusterMode) {
  if (clusterMode != null && String(clusterMode).trim() !== '') {
    return normalizeClusterMode(clusterMode);
  }
  try {
    const deviceProfile = require('./device-profile');
    return normalizeClusterMode(deviceProfile.getClusterMode());
  } catch {
    return 'standalone';
  }
}

function listRolesForClusterMode(clusterMode) {
  const mode = normalizeClusterMode(clusterMode);
  if (mode === 'master') {
    return MASTER_ROLE_IDS.map((id) => getEffectiveRole(id, 'master')).filter(Boolean);
  }
  if (mode === 'slave') {
    return ROLES.map((role) => getEffectiveRole(role.id, 'slave'));
  }
  return [];
}

function isRoleAllowedForClusterMode(clusterMode, roleId) {
  const mode = normalizeClusterMode(clusterMode);
  if (mode === 'standalone') return false;
  return listRolesForClusterMode(mode).some((role) => role.id === roleId);
}

function getDefaultRoleIdForClusterMode(clusterMode) {
  const mode = normalizeClusterMode(clusterMode);
  if (mode === 'standalone') return STANDALONE_DEFAULT_ROLE_ID;
  if (mode === 'master') return 'admin';
  return 'operator';
}

function listRoles() {
  return ROLES;
}

function getRole(roleId) {
  return ROLES.find((r) => r.id === roleId) || null;
}

/** Resolve role with cluster-mode overrides (Master Admin / Viewer access matrix). */
function getEffectiveRole(roleId, clusterMode) {
  const base = getRole(roleId);
  if (!base) return null;
  const mode = resolveClusterMode(clusterMode);
  if (mode === 'master' && MASTER_ROLE_ACCESS[base.id]) {
    const override = MASTER_ROLE_ACCESS[base.id];
    return {
      id: base.id,
      name: override.name || base.name,
      description: override.description || base.description,
      permissions: [...override.permissions],
    };
  }
  return {
    id: base.id,
    name: base.name,
    description: base.description,
    permissions: [...base.permissions],
  };
}

function getUserRole(meshUserId) {
  const row = getDb()
    .prepare('SELECT role_id FROM user_dashboard_roles WHERE mesh_user_id = ?')
    .get(String(meshUserId || '').trim());
  return row ? getEffectiveRole(row.role_id) : null;
}

function setUserRole(meshUserId, roleId) {
  const role = getRole(roleId);
  if (!role) {
    const err = new Error('Invalid role. Choose a valid dashboard role.');
    err.status = 400;
    throw err;
  }
  getDb()
    .prepare(`
      INSERT INTO user_dashboard_roles (mesh_user_id, role_id, assigned_at)
      VALUES (?, ?, ?)
      ON CONFLICT(mesh_user_id) DO UPDATE SET
        role_id = excluded.role_id,
        assigned_at = excluded.assigned_at
    `)
    .run(String(meshUserId).trim(), role.id, Date.now());
  return getEffectiveRole(role.id);
}

function hasPermission(roleId, permission, clusterMode) {
  if (!permission) return true;
  const role = getEffectiveRole(roleId, clusterMode);
  if (!role) return false;
  if (role.permissions.includes('*')) return true;
  if (role.permissions.includes(permission)) return true;
  const [ns] = String(permission).split('.');
  return role.permissions.includes(`${ns}.*`);
}

function hasAnyPermission(roleId, permissions, clusterMode) {
  const list = Array.isArray(permissions) ? permissions : [permissions];
  return list.some((p) => hasPermission(roleId, p, clusterMode));
}

function normalizePathname(pathname) {
  if (!pathname) return '/';
  let p = String(pathname).split('?')[0];
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p || '/';
}

function getPagePermission(pathname) {
  const p = normalizePathname(pathname);
  if (PAGE_PERMISSIONS[p]) return PAGE_PERMISSIONS[p];
  if (p.startsWith('/cameras/')) return 'live.view';
  if (p.startsWith('/detection/')) return 'detection.view';
  return null;
}

function canAccessRoute(roleId, route, clusterMode) {
  const perm = getPagePermission(route) || PAGE_PERMISSIONS[route];
  if (!perm) return hasPermission(roleId, 'dashboard.read', clusterMode);
  return hasPermission(roleId, perm, clusterMode);
}

function canAccessPath(roleId, pathname, clusterMode) {
  const perm = getPagePermission(pathname);
  if (!perm) return true;
  return hasPermission(roleId, perm, clusterMode);
}

function matchApiRule(method, apiPath) {
  const m = String(method || 'GET').toUpperCase();
  const p = normalizePathname(apiPath);
  for (const rule of API_RULES) {
    if (rule.method && rule.method !== m) continue;
    if (!rule.match.test(p)) continue;
    return rule;
  }
  return null;
}

function canAccessApi(roleId, method, apiPath, clusterMode) {
  const rule = matchApiRule(method, apiPath);
  if (!rule) {
    return hasPermission(roleId, 'dashboard.read', clusterMode);
  }
  if (rule.permission === null && !rule.permissions) return true;
  if (rule.permissions) return hasAnyPermission(roleId, rule.permissions, clusterMode);
  return hasPermission(roleId, rule.permission, clusterMode);
}

function getNavAccess(roleId, clusterMode) {
  const access = {};
  for (const [navId, perm] of Object.entries(NAV_PERMISSIONS)) {
    access[navId] = hasPermission(roleId, perm, clusterMode);
  }
  return access;
}

function getAllowedRoutes(roleId, clusterMode) {
  return Object.keys(PAGE_PERMISSIONS).filter((route) => canAccessPath(roleId, route, clusterMode));
}

function getDefaultLandingPath(roleId, clusterMode) {
  const preferred = [
    '/overview',
    '/detection/person',
    '/detection/face',
    '/dashboard#/ai-models',
    '/alert-configuration',
    '/settings',
    '/dashboard#/settings',
  ];
  for (const route of preferred) {
    const pathOnly = route.split('#')[0];
    if (canAccessPath(roleId, pathOnly, clusterMode)) return route;
  }
  return '/overview';
}

function getRolePayload(roleId, clusterMode) {
  const role = getEffectiveRole(roleId, clusterMode);
  if (!role) return null;
  const mode = resolveClusterMode(clusterMode);
  return {
    id: role.id,
    name: role.name,
    description: role.description,
    permissions: role.permissions,
    allowedRoutes: getAllowedRoutes(role.id, mode),
    navAccess: getNavAccess(role.id, mode),
    landingPath: getDefaultLandingPath(role.id, mode),
  };
}

function resolveSessionRoleId(sess) {
  if (!sess) return null;
  if (sess.userRole) return sess.userRole;
  const saved = getUserRole(sess.meshUserId);
  return saved?.id || null;
}

module.exports = {
  ROLES,
  MASTER_ROLE_IDS,
  MASTER_ROLE_ACCESS,
  STANDALONE_DEFAULT_ROLE_ID,
  NAV_PERMISSIONS,
  PAGE_PERMISSIONS,
  ROUTE_PERMISSIONS: PAGE_PERMISSIONS,
  listRoles,
  listRolesForClusterMode,
  isRoleAllowedForClusterMode,
  getDefaultRoleIdForClusterMode,
  normalizeClusterMode,
  resolveClusterMode,
  getRole,
  getEffectiveRole,
  getUserRole,
  setUserRole,
  hasPermission,
  hasAnyPermission,
  canAccessRoute,
  canAccessPath,
  canAccessApi,
  getNavAccess,
  getAllowedRoutes,
  getDefaultLandingPath,
  getRolePayload,
  resolveSessionRoleId,
  getPagePermission,
};
