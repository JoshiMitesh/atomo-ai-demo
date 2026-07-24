const crypto = require('crypto');
const { getDb } = require('./db');

function createId() {
  return `tenant_${crypto.randomUUID()}`;
}

function mapTenant(row) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    ownerUserId: row.owner_user_id,
    plan: row.plan,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    suspendedAt: row.suspended_at ? new Date(row.suspended_at).toISOString() : null,
    archivedAt: row.archived_at ? new Date(row.archived_at).toISOString() : null,
  };
}

function ensureDefaultTenant({ name, slug, ownerUserId }) {
  const existing = getDb().prepare('SELECT * FROM tenants LIMIT 1').get();
  if (existing) return mapTenant(existing);

  const now = Date.now();
  const id = createId();
  getDb()
    .prepare(`
      INSERT INTO tenants (
        id, name, slug, status, owner_user_id, plan, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, 'active', ?, 'enterprise', NULL, ?, ?)
    `)
    .run(id, name || 'Default Organization', slug || 'default', ownerUserId || null, now, now);
  return mapTenant(getDb().prepare('SELECT * FROM tenants WHERE id = ?').get(id));
}

function listTenants() {
  return getDb()
    .prepare('SELECT * FROM tenants ORDER BY created_at DESC')
    .all()
    .map(mapTenant);
}

function getTenant(id) {
  const row = getDb().prepare('SELECT * FROM tenants WHERE id = ?').get(id);
  return row ? mapTenant(row) : null;
}

function createTenant(payload, createdBy) {
  const now = Date.now();
  const id = createId();
  getDb()
    .prepare(`
      INSERT INTO tenants (
        id, name, slug, status, owner_user_id, plan, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?)
    `)
    .run(
      id,
      payload.name,
      payload.slug,
      payload.ownerUserId || createdBy || null,
      payload.plan || 'standard',
      payload.metadata != null ? JSON.stringify(payload.metadata) : null,
      now,
      now
    );
  return getTenant(id);
}

function updateTenantStatus(id, status) {
  const now = Date.now();
  const patch = { status, updated_at: now };
  if (status === 'suspended') patch.suspended_at = now;
  if (status === 'archived') patch.archived_at = now;
  getDb()
    .prepare(`
      UPDATE tenants SET
        status = ?,
        updated_at = ?,
        suspended_at = COALESCE(?, suspended_at),
        archived_at = COALESCE(?, archived_at)
      WHERE id = ?
    `)
    .run(status, now, status === 'suspended' ? now : null, status === 'archived' ? now : null, id);
  return getTenant(id);
}

function getTenantAnalytics() {
  const tenants = listTenants();
  return {
    total: tenants.length,
    active: tenants.filter((t) => t.status === 'active').length,
    suspended: tenants.filter((t) => t.status === 'suspended').length,
    archived: tenants.filter((t) => t.status === 'archived').length,
    byPlan: tenants.reduce((acc, t) => {
      acc[t.plan] = (acc[t.plan] || 0) + 1;
      return acc;
    }, {}),
  };
}

module.exports = {
  ensureDefaultTenant,
  listTenants,
  getTenant,
  createTenant,
  updateTenantStatus,
  getTenantAnalytics,
};
