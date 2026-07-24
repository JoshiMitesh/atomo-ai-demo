const { getDb } = require('./db');

const SYSTEM_ROLES = [
  {
    id: 'super_admin',
    name: 'Super Admin',
    description: 'Full platform control across all tenants and settings.',
    permissions: ['*'],
    isSystem: true,
  },
  {
    id: 'platform_admin',
    name: 'Platform Admin',
    description: 'Manage platform configuration, tenants, and feature flags.',
    permissions: [
      'platform.read',
      'platform.write',
      'tenants.read',
      'tenants.write',
      'flags.read',
      'flags.write',
      'config.read',
      'config.write',
      'audit.read',
      'users.read',
      'monitoring.read',
    ],
    isSystem: true,
  },
  {
    id: 'security_admin',
    name: 'Security Admin',
    description: 'Security operations, audit review, and incident response.',
    permissions: [
      'platform.read',
      'security.read',
      'security.write',
      'audit.read',
      'users.read',
      'users.suspend',
    ],
    isSystem: true,
  },
  {
    id: 'operations_admin',
    name: 'Operations Admin',
    description: 'System health, monitoring, and maintenance operations.',
    permissions: [
      'platform.read',
      'platform.maintenance',
      'monitoring.read',
      'monitoring.write',
      'audit.read',
    ],
    isSystem: true,
  },
  {
    id: 'tenant_admin',
    name: 'Tenant Admin',
    description: 'Manage users and settings within a tenant scope.',
    permissions: [
      'tenants.read',
      'users.read',
      'users.write',
      'flags.read',
      'config.read',
    ],
    isSystem: true,
  },
  {
    id: 'user',
    name: 'User',
    description: 'Standard dashboard access with no master control privileges.',
    permissions: ['dashboard.read'],
    isSystem: true,
  },
];

function seedRoles() {
  const db = getDb();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO roles (id, name, description, permissions, is_system, created_at)
    VALUES (@id, @name, @description, @permissions, @isSystem, @createdAt)
  `);
  const now = Date.now();
  for (const role of SYSTEM_ROLES) {
    insert.run({
      id: role.id,
      name: role.name,
      description: role.description,
      permissions: JSON.stringify(role.permissions),
      isSystem: role.isSystem ? 1 : 0,
      createdAt: now,
    });
  }
}

function getRole(roleId) {
  const row = getDb().prepare('SELECT * FROM roles WHERE id = ?').get(roleId);
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    permissions: JSON.parse(row.permissions),
    isSystem: row.is_system === 1,
  };
}

function listRoles() {
  return getDb()
    .prepare('SELECT * FROM roles ORDER BY is_system DESC, name ASC')
    .all()
    .map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      permissions: JSON.parse(row.permissions),
      isSystem: row.is_system === 1,
    }));
}

function getUserRole(meshUserId) {
  const row = getDb()
    .prepare(`
      SELECT r.* FROM user_roles ur
      JOIN roles r ON r.id = ur.role_id
      WHERE ur.mesh_user_id = ?
    `)
    .get(meshUserId);
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    permissions: JSON.parse(row.permissions),
    isSystem: row.is_system === 1,
  };
}

function assignRole(meshUserId, roleId, assignedBy) {
  getDb()
    .prepare(`
      INSERT INTO user_roles (mesh_user_id, role_id, assigned_at, assigned_by)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(mesh_user_id) DO UPDATE SET
        role_id = excluded.role_id,
        assigned_at = excluded.assigned_at,
        assigned_by = excluded.assigned_by
    `)
    .run(meshUserId, roleId, Date.now(), assignedBy || null);
}

function ensureDefaultAdmin(meshUserId, assignedBy) {
  seedRoles();
  const existing = getDb()
    .prepare('SELECT mesh_user_id FROM user_roles WHERE mesh_user_id = ?')
    .get(meshUserId);
  if (!existing) {
    assignRole(meshUserId, 'super_admin', assignedBy || 'system');
  }
}

function hasPermission(meshUserId, permission) {
  const role = getUserRole(meshUserId);
  if (!role) return false;
  if (role.permissions.includes('*')) return true;
  if (role.permissions.includes(permission)) return true;
  const [namespace] = permission.split('.');
  return role.permissions.includes(`${namespace}.*`);
}

function requirePermission(meshUserId, permission) {
  if (!hasPermission(meshUserId, permission)) {
    const err = new Error('Insufficient permissions.');
    err.status = 403;
    err.code = 'FORBIDDEN';
    throw err;
  }
}

seedRoles();

module.exports = {
  SYSTEM_ROLES,
  seedRoles,
  getRole,
  listRoles,
  getUserRole,
  assignRole,
  ensureDefaultAdmin,
  hasPermission,
  requirePermission,
};
