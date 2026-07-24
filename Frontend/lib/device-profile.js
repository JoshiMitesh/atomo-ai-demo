const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { getDeviceBindingDbPath } = require('./device-config');

let db;

function getDb() {
  if (db) return db;
  const dbPath = getDeviceBindingDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS device_profile (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      device_serial TEXT,
      device_name TEXT NOT NULL,
      device_type TEXT NOT NULL,
      operating_system TEXT NOT NULL,
      organization_name TEXT NOT NULL,
      admin_name TEXT NOT NULL,
      admin_role TEXT NOT NULL,
      email TEXT,
      phone TEXT,
      country TEXT NOT NULL,
      city TEXT NOT NULL,
      cluster_mode TEXT,
      register_meshcentral INTEGER NOT NULL DEFAULT 0,
      mesh_group_name TEXT,
      registered_by TEXT,
      registered_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS user_onboarding (
      mesh_user_id TEXT PRIMARY KEY,
      email TEXT,
      registered_at INTEGER NOT NULL
    );
  `);
  ensureColumn(db, 'device_profile', 'cluster_mode', 'TEXT');
  return db;
}

function ensureColumn(database, table, column, typeSql) {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some((c) => c.name === column)) return;
  database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${typeSql};`);
}

function rowToProfile(row) {
  if (!row) return null;
  return {
    deviceSerial: row.device_serial,
    deviceName: row.device_name,
    deviceType: row.device_type,
    operatingSystem: row.operating_system,
    organizationName: row.organization_name,
    adminName: row.admin_name,
    adminRole: row.admin_role,
    email: row.email,
    phone: row.phone,
    country: row.country,
    city: row.city,
    clusterMode: row.cluster_mode || null,
    registerMeshCentral: !!row.register_meshcentral,
    meshGroupName: row.mesh_group_name,
    registeredBy: row.registered_by,
    registeredAt: row.registered_at,
  };
}

function getProfile() {
  const row = getDb().prepare('SELECT * FROM device_profile WHERE id = 1').get();
  return rowToProfile(row);
}

function isRegistered() {
  return getProfile() != null;
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function usernameFromMeshUserId(meshUserId) {
  const id = String(meshUserId || '');
  const slash = id.lastIndexOf('/');
  return slash >= 0 ? id.slice(slash + 1) : id.replace(/^user\/\//, '');
}

function markUserOnboarded({ meshUserId, email }) {
  const uid = String(meshUserId || '').trim();
  if (!uid) return null;
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO user_onboarding (mesh_user_id, email, registered_at)
       VALUES (?, ?, ?)
       ON CONFLICT(mesh_user_id) DO UPDATE SET
         email = COALESCE(excluded.email, user_onboarding.email),
         registered_at = excluded.registered_at`
    )
    .run(uid, email ? normalizeEmail(email) : null, now);
  return { meshUserId: uid, email: email ? normalizeEmail(email) : null, registeredAt: now };
}

function getUserOnboarding(meshUserId) {
  const uid = String(meshUserId || '').trim();
  if (!uid) return null;
  const row = getDb().prepare('SELECT * FROM user_onboarding WHERE mesh_user_id = ?').get(uid);
  if (!row) return null;
  return {
    meshUserId: row.mesh_user_id,
    email: row.email,
    registeredAt: row.registered_at,
  };
}

function isUserOnboarded(meshUserId) {
  const uid = String(meshUserId || '').trim();
  if (!uid) return false;
  if (getUserOnboarding(uid)) return true;

  const profile = getProfile();
  if (!profile?.registeredBy) return false;

  const profileUser = String(profile.registeredBy).trim().toLowerCase();
  const sessionUser = usernameFromMeshUserId(uid).toLowerCase();
  if (profileUser && profileUser === sessionUser) {
    markUserOnboarded({ meshUserId: uid, email: profile.email });
    return true;
  }
  return false;
}

function emailsMatch(accountEmail, formEmail) {
  const a = normalizeEmail(accountEmail);
  const b = normalizeEmail(formEmail);
  if (!a || !b) return false;
  return a === b;
}

function saveProfile(data) {
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO device_profile (
        id, device_serial, device_name, device_type, operating_system,
        organization_name, admin_name, admin_role, email, phone,
        country, city, cluster_mode, register_meshcentral, mesh_group_name,
        registered_by, registered_at
      ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        device_serial = excluded.device_serial,
        device_name = excluded.device_name,
        device_type = excluded.device_type,
        operating_system = excluded.operating_system,
        organization_name = excluded.organization_name,
        admin_name = excluded.admin_name,
        admin_role = excluded.admin_role,
        email = excluded.email,
        phone = excluded.phone,
        country = excluded.country,
        city = excluded.city,
        cluster_mode = COALESCE(excluded.cluster_mode, device_profile.cluster_mode),
        register_meshcentral = excluded.register_meshcentral,
        mesh_group_name = excluded.mesh_group_name,
        registered_by = excluded.registered_by,
        registered_at = excluded.registered_at`
    )
    .run(
      data.deviceSerial || null,
      data.deviceName,
      data.deviceType,
      data.operatingSystem,
      data.organizationName,
      data.adminName,
      data.adminRole,
      data.email || null,
      data.phone || null,
      data.country,
      data.city,
      data.clusterMode || null,
      data.registerMeshCentral ? 1 : 0,
      data.meshGroupName || null,
      data.registeredBy || null,
      now
    );
  return getProfile();
}

function getClusterMode() {
  return getProfile()?.clusterMode || null;
}

function setClusterMode(clusterMode) {
  const mode = String(clusterMode || '').trim().toLowerCase();
  if (!['master', 'slave', 'standalone'].includes(mode)) {
    const err = new Error('Invalid cluster mode. Use master, slave, or standalone.');
    err.status = 400;
    throw err;
  }
  getDb().prepare('UPDATE device_profile SET cluster_mode = ? WHERE id = 1').run(mode);
  return getClusterMode();
}

module.exports = {
  getProfile,
  isRegistered,
  saveProfile,
  getClusterMode,
  setClusterMode,
  markUserOnboarded,
  getUserOnboarding,
  isUserOnboarded,
  emailsMatch,
  normalizeEmail,
};
