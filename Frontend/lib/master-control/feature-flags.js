const crypto = require('crypto');
const { getDb } = require('./db');

const DEFAULT_FLAGS = [
  { key: 'ai_chat', scope: 'global', enabled: true },
  { key: 'billing', scope: 'global', enabled: true },
  { key: 'api_access', scope: 'global', enabled: true },
  { key: 'advanced_reports', scope: 'global', enabled: true },
  { key: 'master_control', scope: 'global', enabled: true },
  { key: 'offline_login', scope: 'global', enabled: true },
];

function createId() {
  return `flag_${crypto.randomUUID()}`;
}

function seedDefaultFlags() {
  const db = getDb();
  const exists = db.prepare('SELECT COUNT(*) AS count FROM feature_flags').get().count;
  if (exists > 0) return;
  const insert = db.prepare(`
    INSERT INTO feature_flags (
      id, key, scope, scope_id, enabled, rollout_percent, metadata,
      scheduled_at, expires_at, created_at, updated_at, updated_by
    ) VALUES (?, ?, ?, NULL, ?, 100, NULL, NULL, NULL, ?, ?, 'system')
  `);
  const now = Date.now();
  for (const flag of DEFAULT_FLAGS) {
    insert.run(createId(), flag.key, flag.scope, flag.enabled ? 1 : 0, now, now);
  }
}

function mapFlag(row) {
  return {
    id: row.id,
    key: row.key,
    scope: row.scope,
    scopeId: row.scope_id,
    enabled: row.enabled === 1,
    rolloutPercent: row.rollout_percent,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
    scheduledAt: row.scheduled_at ? new Date(row.scheduled_at).toISOString() : null,
    expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    updatedBy: row.updated_by,
  };
}

function listFlags({ scope, scopeId } = {}) {
  seedDefaultFlags();
  const clauses = [];
  const params = [];
  if (scope) {
    clauses.push('scope = ?');
    params.push(scope);
  }
  if (scopeId !== undefined) {
    clauses.push('scope_id IS ?');
    params.push(scopeId);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return getDb()
    .prepare(`SELECT * FROM feature_flags ${where} ORDER BY key ASC, scope ASC`)
    .all(...params)
    .map(mapFlag);
}

function upsertFlag(payload, updatedBy) {
  seedDefaultFlags();
  const now = Date.now();
  const existing = getDb()
    .prepare(`
      SELECT * FROM feature_flags
      WHERE key = ? AND scope = ? AND COALESCE(scope_id, '') = COALESCE(?, '')
    `)
    .get(payload.key, payload.scope, payload.scopeId || null);

  if (existing) {
    getDb()
      .prepare(`
        UPDATE feature_flags SET
          enabled = ?,
          rollout_percent = ?,
          metadata = ?,
          scheduled_at = ?,
          expires_at = ?,
          updated_at = ?,
          updated_by = ?
        WHERE id = ?
      `)
      .run(
        payload.enabled ? 1 : 0,
        payload.rolloutPercent ?? existing.rollout_percent,
        payload.metadata != null ? JSON.stringify(payload.metadata) : existing.metadata,
        payload.scheduledAt ? new Date(payload.scheduledAt).getTime() : existing.scheduled_at,
        payload.expiresAt ? new Date(payload.expiresAt).getTime() : existing.expires_at,
        now,
        updatedBy || null,
        existing.id
      );
    return mapFlag(getDb().prepare('SELECT * FROM feature_flags WHERE id = ?').get(existing.id));
  }

  const id = createId();
  getDb()
    .prepare(`
      INSERT INTO feature_flags (
        id, key, scope, scope_id, enabled, rollout_percent, metadata,
        scheduled_at, expires_at, created_at, updated_at, updated_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      id,
      payload.key,
      payload.scope,
      payload.scopeId || null,
      payload.enabled ? 1 : 0,
      payload.rolloutPercent ?? 100,
      payload.metadata != null ? JSON.stringify(payload.metadata) : null,
      payload.scheduledAt ? new Date(payload.scheduledAt).getTime() : null,
      payload.expiresAt ? new Date(payload.expiresAt).getTime() : null,
      now,
      now,
      updatedBy || null
    );
  return mapFlag(getDb().prepare('SELECT * FROM feature_flags WHERE id = ?').get(id));
}

function isFlagEnabled(key, { scope = 'global', scopeId = null, userId = null } = {}) {
  seedDefaultFlags();
  const now = Date.now();
  const candidates = getDb()
    .prepare(`
      SELECT * FROM feature_flags
      WHERE key = ?
        AND (
          (scope = 'global' AND scope_id IS NULL)
          OR (scope = ? AND COALESCE(scope_id, '') = COALESCE(?, ''))
          OR (scope = 'user' AND scope_id = ?)
        )
      ORDER BY
        CASE scope
          WHEN 'user' THEN 1
          WHEN 'tenant' THEN 2
          WHEN 'role' THEN 3
          WHEN 'environment' THEN 4
          ELSE 5
        END
    `)
    .all(key, scope, scopeId, userId);

  for (const row of candidates) {
    if (row.scheduled_at && row.scheduled_at > now) continue;
    if (row.expires_at && row.expires_at <= now) continue;
    if (row.rollout_percent < 100 && userId) {
      const hash = crypto.createHash('sha256').update(`${key}:${userId}`).digest();
      const bucket = hash[0] % 100;
      if (bucket >= row.rollout_percent) continue;
    }
    return row.enabled === 1;
  }
  return false;
}

seedDefaultFlags();

module.exports = {
  listFlags,
  upsertFlag,
  isFlagEnabled,
  seedDefaultFlags,
};
