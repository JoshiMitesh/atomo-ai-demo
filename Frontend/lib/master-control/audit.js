const crypto = require('crypto');
const { getDb } = require('./db');

function createId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function writeAudit({
  actorUserId,
  actorUsername,
  action,
  resourceType,
  resourceId,
  oldValue,
  newValue,
  ipAddress,
  userAgent,
  metadata,
}) {
  const id = createId('aud');
  getDb()
    .prepare(`
      INSERT INTO audit_logs (
        id, actor_user_id, actor_username, action, resource_type, resource_id,
        old_value, new_value, ip_address, user_agent, metadata, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      id,
      actorUserId || null,
      actorUsername || null,
      action,
      resourceType,
      resourceId || null,
      oldValue != null ? JSON.stringify(oldValue) : null,
      newValue != null ? JSON.stringify(newValue) : null,
      ipAddress || null,
      userAgent || null,
      metadata != null ? JSON.stringify(metadata) : null,
      Date.now()
    );
  return id;
}

function listAuditLogs({ limit = 50, offset = 0, resourceType, actorUserId } = {}) {
  const clauses = [];
  const params = [];
  if (resourceType) {
    clauses.push('resource_type = ?');
    params.push(resourceType);
  }
  if (actorUserId) {
    clauses.push('actor_user_id = ?');
    params.push(actorUserId);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = getDb()
    .prepare(`
      SELECT * FROM audit_logs
      ${where}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `)
    .all(...params, limit, offset);
  const total = getDb()
    .prepare(`SELECT COUNT(*) AS count FROM audit_logs ${where}`)
    .get(...params).count;
  return {
    total,
    items: rows.map(mapAuditRow),
  };
}

function mapAuditRow(row) {
  return {
    id: row.id,
    actorUserId: row.actor_user_id,
    actorUsername: row.actor_username,
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    oldValue: row.old_value ? JSON.parse(row.old_value) : null,
    newValue: row.new_value ? JSON.parse(row.new_value) : null,
    ipAddress: row.ip_address,
    userAgent: row.user_agent,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function recordSecurityEvent({
  eventType,
  severity = 'info',
  actorUserId,
  description,
  metadata,
  ipAddress,
}) {
  const id = createId('sec');
  getDb()
    .prepare(`
      INSERT INTO security_events (
        id, event_type, severity, actor_user_id, description, metadata, ip_address, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      id,
      eventType,
      severity,
      actorUserId || null,
      description,
      metadata != null ? JSON.stringify(metadata) : null,
      ipAddress || null,
      Date.now()
    );
  return id;
}

function listSecurityEvents({ limit = 50, offset = 0, severity } = {}) {
  const clauses = [];
  const params = [];
  if (severity) {
    clauses.push('severity = ?');
    params.push(severity);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = getDb()
    .prepare(`
      SELECT * FROM security_events
      ${where}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `)
    .all(...params, limit, offset);
  const total = getDb()
    .prepare(`SELECT COUNT(*) AS count FROM security_events ${where}`)
    .get(...params).count;
  return {
    total,
    items: rows.map((row) => ({
      id: row.id,
      eventType: row.event_type,
      severity: row.severity,
      actorUserId: row.actor_user_id,
      description: row.description,
      metadata: row.metadata ? JSON.parse(row.metadata) : null,
      ipAddress: row.ip_address,
      createdAt: new Date(row.created_at).toISOString(),
    })),
  };
}

module.exports = {
  writeAudit,
  listAuditLogs,
  recordSecurityEvent,
  listSecurityEvents,
};
