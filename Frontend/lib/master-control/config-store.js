const crypto = require('crypto');
const { getDb } = require('./db');
const { getMasterControlEnvironment } = require('./config');

const DEFAULT_CONFIG = {
  system: {
    appName: 'Atomo Forge',
    logoUrl: '/assets/logo.svg',
    theme: 'dark',
    primaryDomain: 'localhost',
  },
  security: {
    passwordMinLength: 12,
    mfaRequired: false,
    sessionDurationHours: 24,
    ipRestrictions: [],
  },
  email: {
    provider: 'smtp',
    fromAddress: 'noreply@atomo.io',
  },
  storage: {
    provider: 'local',
    bucket: 'atomo-forge-local',
  },
  ai: {
    defaultProvider: 'openai',
    enabledProviders: ['openai', 'anthropic'],
  },
};

function createId() {
  return `cfg_${crypto.randomUUID()}`;
}

function seedDefaultConfig() {
  const db = getDb();
  const env = getMasterControlEnvironment();
  const exists = db
    .prepare('SELECT COUNT(*) AS count FROM config_entries WHERE environment = ?')
    .get(env).count;
  if (exists > 0) return;

  const insert = db.prepare(`
    INSERT INTO config_entries (
      id, category, key, value, environment, version, is_active, created_at, created_by, change_note
    ) VALUES (?, ?, ?, ?, ?, 1, 1, ?, 'system', 'Initial seed')
  `);
  const now = Date.now();
  for (const [category, entries] of Object.entries(DEFAULT_CONFIG)) {
    for (const [key, value] of Object.entries(entries)) {
      insert.run(createId(), category, key, JSON.stringify(value), env, now);
    }
  }
}

function getActiveConfig(environment = getMasterControlEnvironment()) {
  seedDefaultConfig();
  const rows = getDb()
    .prepare(`
      SELECT category, key, value, version, created_at, created_by, change_note
      FROM config_entries
      WHERE environment = ? AND is_active = 1
      ORDER BY category, key
    `)
    .all(environment);

  const config = {};
  for (const row of rows) {
    if (!config[row.category]) config[row.category] = {};
    config[row.category][row.key] = JSON.parse(row.value);
  }
  return {
    environment,
    config,
    updatedAt: rows.length ? new Date(Math.max(...rows.map((r) => r.created_at))).toISOString() : null,
  };
}

function getConfigHistory(category, key, environment = getMasterControlEnvironment()) {
  seedDefaultConfig();
  return getDb()
    .prepare(`
      SELECT id, value, version, is_active, created_at, created_by, change_note
      FROM config_entries
      WHERE category = ? AND key = ? AND environment = ?
      ORDER BY version DESC
    `)
    .all(category, key, environment)
    .map((row) => ({
      id: row.id,
      value: JSON.parse(row.value),
      version: row.version,
      isActive: row.is_active === 1,
      createdAt: new Date(row.created_at).toISOString(),
      createdBy: row.created_by,
      changeNote: row.change_note,
    }));
}

function setConfigValue(category, key, value, { environment, createdBy, changeNote } = {}) {
  seedDefaultConfig();
  const env = environment || getMasterControlEnvironment();
  const current = getDb()
    .prepare(`
      SELECT version FROM config_entries
      WHERE category = ? AND key = ? AND environment = ? AND is_active = 1
    `)
    .get(category, key, env);
  const nextVersion = current ? current.version + 1 : 1;

  const tx = getDb().transaction(() => {
    getDb()
      .prepare(`
        UPDATE config_entries
        SET is_active = 0
        WHERE category = ? AND key = ? AND environment = ? AND is_active = 1
      `)
      .run(category, key, env);
    const id = createId();
    getDb()
      .prepare(`
        INSERT INTO config_entries (
          id, category, key, value, environment, version, is_active, created_at, created_by, change_note
        ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
      `)
      .run(
        id,
        category,
        key,
        JSON.stringify(value),
        env,
        nextVersion,
        Date.now(),
        createdBy || null,
        changeNote || null
      );
    return id;
  });

  return tx();
}

function rollbackConfig(category, key, version, { environment, createdBy } = {}) {
  const env = environment || getMasterControlEnvironment();
  const target = getDb()
    .prepare(`
      SELECT * FROM config_entries
      WHERE category = ? AND key = ? AND environment = ? AND version = ?
    `)
    .get(category, key, env, version);
  if (!target) {
    const err = new Error('Configuration version not found.');
    err.status = 404;
    throw err;
  }
  return setConfigValue(category, key, JSON.parse(target.value), {
    environment: env,
    createdBy,
    changeNote: `Rollback to version ${version}`,
  });
}

seedDefaultConfig();

module.exports = {
  getActiveConfig,
  getConfigHistory,
  setConfigValue,
  rollbackConfig,
  DEFAULT_CONFIG,
};
