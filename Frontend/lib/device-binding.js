const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const meshPass = require('../atomic/MeshCentral-master/pass.js');
const {
  getDeviceBindingDbPath,
  getDeviceIdPath,
  offlineLoginEnabled,
  singleUserPerDevice,
} = require('./device-config');

let db;

function getDb() {
  if (db) return db;
  const dbPath = getDeviceBindingDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS device_binding (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      device_id TEXT NOT NULL,
      mesh_user_id TEXT NOT NULL,
      username TEXT NOT NULL COLLATE NOCASE,
      email TEXT,
      salt TEXT NOT NULL,
      hash TEXT NOT NULL,
      bound_at INTEGER NOT NULL
    );
  `);
  return db;
}

function formatDeviceSerial(deviceId, createdAt) {
  const hex = String(deviceId).replace(/-/g, '').toUpperCase();
  const year = createdAt
    ? new Date(createdAt * 1000).getFullYear()
    : new Date().getFullYear();
  return `APU-${year}-${hex.slice(0, 4)}-${hex.slice(4, 8)}`;
}

function readDeviceFile() {
  const devicePath = getDeviceIdPath();
  fs.mkdirSync(path.dirname(devicePath), { recursive: true });
  if (fs.existsSync(devicePath)) {
    try {
      return JSON.parse(fs.readFileSync(devicePath, 'utf8'));
    } catch {
      /* regenerate below */
    }
  }
  return null;
}

function writeDeviceFile(data) {
  const devicePath = getDeviceIdPath();
  fs.writeFileSync(devicePath, JSON.stringify(data, null, 2));
}

function getDeviceId() {
  const existing = readDeviceFile();
  if (existing?.deviceId) return existing.deviceId;

  const createdAt = Math.floor(Date.now() / 1000);
  const deviceId = crypto.randomUUID();
  writeDeviceFile({
    deviceId,
    deviceSerial: formatDeviceSerial(deviceId, createdAt),
    createdAt,
  });
  return deviceId;
}

/** Human-readable serial derived once from the device UUID (e.g. APU-2026-E6B5-04EF). */
function getDeviceSerial() {
  const data = readDeviceFile();
  if (data?.deviceSerial) return data.deviceSerial;

  const deviceId = getDeviceId();
  const fresh = readDeviceFile();
  if (fresh?.deviceSerial) return fresh.deviceSerial;

  const createdAt = fresh?.createdAt || Math.floor(Date.now() / 1000);
  const deviceSerial = formatDeviceSerial(deviceId, createdAt);
  writeDeviceFile({ ...fresh, deviceId, deviceSerial, createdAt });
  return deviceSerial;
}

function hashPassword(password) {
  return new Promise((resolve, reject) => {
    meshPass.hash(password, (err, salt, hash) => {
      if (err) reject(err);
      else resolve({ salt, hash });
    }, 0);
  });
}

function verifyPassword(password, salt, storedHash) {
  return new Promise((resolve, reject) => {
    meshPass.hash(password, salt, (err, hash) => {
      if (err) reject(err);
      else resolve(hash === storedHash);
    }, 0);
  });
}

function getBinding() {
  if (!singleUserPerDevice() && !offlineLoginEnabled()) return null;
  const row = getDb().prepare('SELECT * FROM device_binding WHERE id = 1').get();
  if (!row) return null;
  return {
    deviceId: row.device_id,
    meshUserId: row.mesh_user_id,
    username: row.username,
    email: row.email,
    boundAt: row.bound_at,
  };
}

function isBound() {
  return getBinding() != null;
}

function usernameMatchesBound(username) {
  const binding = getBinding();
  if (!binding) return true;
  return binding.username.toLowerCase() === String(username || '').trim().toLowerCase();
}

function meshUserIdMatchesBound(meshUserId) {
  const binding = getBinding();
  if (!binding) return true;
  return binding.meshUserId === meshUserId;
}

function checkUserAllowed(username) {
  if (!singleUserPerDevice()) return { ok: true };
  const binding = getBinding();
  if (!binding) return { ok: true };
  if (usernameMatchesBound(username)) return { ok: true };
  return {
    ok: false,
    status: 403,
    error: `This device is registered to "${binding.username}". Only that user can sign in here.`,
  };
}

function checkSignupAllowed() {
  if (!singleUserPerDevice()) return { ok: true };
  const binding = getBinding();
  if (!binding) return { ok: true };
  return {
    ok: false,
    status: 403,
    error: `This device is already registered to "${binding.username}". Signup is not allowed.`,
  };
}

async function bindUser({ meshUserId, username, email, password }) {
  const name = String(username || '').trim();
  const uid = String(meshUserId || '').trim();
  if (!name || !uid || !password) {
    throw new Error('meshUserId, username, and password are required to bind device.');
  }

  const existing = getBinding();
  if (singleUserPerDevice() && existing) {
    if (existing.meshUserId !== uid && !usernameMatchesBound(name)) {
      const err = new Error(`Device already bound to "${existing.username}".`);
      err.status = 403;
      throw err;
    }
  }

  const { salt, hash } = await hashPassword(password);
  const deviceId = getDeviceId();

  getDb()
    .prepare(
      `INSERT INTO device_binding (id, device_id, mesh_user_id, username, email, salt, hash, bound_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         device_id = excluded.device_id,
         mesh_user_id = excluded.mesh_user_id,
         username = excluded.username,
         email = COALESCE(excluded.email, device_binding.email),
         salt = excluded.salt,
         hash = excluded.hash,
         bound_at = excluded.bound_at`
    )
    .run(deviceId, uid, name, email || null, salt, hash, Date.now());

  return getBinding();
}

async function authenticateBound(username, password) {
  if (!offlineLoginEnabled()) {
    return { ok: false, reason: 'disabled' };
  }

  const binding = getBinding();
  if (!binding) {
    return { ok: false, reason: 'not_bound' };
  }

  const name = String(username || '').trim();
  if (!name || !password) {
    return { ok: false, reason: 'invalid_input' };
  }

  if (!usernameMatchesBound(name)) {
    return { ok: false, reason: 'wrong_user' };
  }

  const row = getDb().prepare('SELECT salt, hash, username, mesh_user_id FROM device_binding WHERE id = 1').get();
  const valid = await verifyPassword(password, row.salt, row.hash);
  if (!valid) {
    return { ok: false, reason: 'bad_password' };
  }

  return {
    ok: true,
    username: row.username,
    meshUserId: row.mesh_user_id,
  };
}

function clearBinding() {
  getDb().prepare('DELETE FROM device_binding WHERE id = 1').run();
}

module.exports = {
  getDeviceId,
  getDeviceSerial,
  getBinding,
  isBound,
  checkUserAllowed,
  checkSignupAllowed,
  bindUser,
  authenticateBound,
  meshUserIdMatchesBound,
  clearBinding,
};
