const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { getMasterControlDbPath } = require('./config');

let db;

function getDb() {
  if (db) return db;
  const dbPath = getMasterControlDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initSchema(db);
  return db;
}

function initSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS platform_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      platform_enabled INTEGER NOT NULL DEFAULT 1,
      maintenance_mode INTEGER NOT NULL DEFAULT 0,
      emergency_lockdown INTEGER NOT NULL DEFAULT 0,
      read_only_mode INTEGER NOT NULL DEFAULT 0,
      feature_freeze INTEGER NOT NULL DEFAULT 0,
      registration_disabled INTEGER NOT NULL DEFAULT 0,
      login_disabled INTEGER NOT NULL DEFAULT 0,
      api_disabled INTEGER NOT NULL DEFAULT 0,
      maintenance_message TEXT,
      updated_at INTEGER NOT NULL,
      updated_by TEXT
    );

    CREATE TABLE IF NOT EXISTS roles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      permissions TEXT NOT NULL,
      is_system INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_roles (
      mesh_user_id TEXT PRIMARY KEY,
      role_id TEXT NOT NULL REFERENCES roles(id),
      assigned_at INTEGER NOT NULL,
      assigned_by TEXT
    );

    CREATE TABLE IF NOT EXISTS feature_flags (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL,
      scope TEXT NOT NULL,
      scope_id TEXT,
      enabled INTEGER NOT NULL DEFAULT 0,
      rollout_percent INTEGER NOT NULL DEFAULT 100,
      metadata TEXT,
      scheduled_at INTEGER,
      expires_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      updated_by TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_feature_flags_scope
      ON feature_flags(key, scope, COALESCE(scope_id, ''));

    CREATE TABLE IF NOT EXISTS config_entries (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      environment TEXT NOT NULL DEFAULT 'production',
      version INTEGER NOT NULL DEFAULT 1,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      created_by TEXT,
      change_note TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_config_active
      ON config_entries(category, key, environment, is_active);

    CREATE TABLE IF NOT EXISTS tenants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'active',
      owner_user_id TEXT,
      plan TEXT DEFAULT 'standard',
      metadata TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      suspended_at INTEGER,
      archived_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      actor_user_id TEXT,
      actor_username TEXT,
      action TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT,
      old_value TEXT,
      new_value TEXT,
      ip_address TEXT,
      user_agent TEXT,
      metadata TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs(actor_user_id);
    CREATE INDEX IF NOT EXISTS idx_audit_resource ON audit_logs(resource_type, resource_id);

    CREATE TABLE IF NOT EXISTS security_events (
      id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'info',
      actor_user_id TEXT,
      description TEXT NOT NULL,
      metadata TEXT,
      ip_address TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_security_events_created ON security_events(created_at DESC);
  `);

  const row = database.prepare('SELECT id FROM platform_state WHERE id = 1').get();
  if (!row) {
    database.prepare(`
      INSERT INTO platform_state (
        id, platform_enabled, maintenance_mode, emergency_lockdown,
        read_only_mode, feature_freeze, registration_disabled,
        login_disabled, api_disabled, updated_at
      ) VALUES (1, 1, 0, 0, 0, 0, 0, 0, 0, ?)
    `).run(Date.now());
  }
}

module.exports = { getDb };
