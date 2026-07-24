/**
 * Face Recognition database — persons, groups, alerts, statistics.
 */

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const DB_PATH = path.join(__dirname, '..', 'data', 'face-database.json');
const ALERTS_PATH = path.join(__dirname, '..', 'data', 'face-alerts.json');
const IMAGES_DIR = path.join(__dirname, '..', 'data', 'face-images');

const BUILTIN_GROUPS = [
  { id: 'employees', name: 'Employees', builtin: true, color: '#10b981', description: 'Staff and internal personnel' },
  { id: 'visitors', name: 'Visitors', builtin: true, color: '#3b82f6', description: 'Temporary visitors and guests' },
  { id: 'contractors', name: 'Contractors', builtin: true, color: '#8b5cf6', description: 'External contractors and vendors' },
  { id: 'vip', name: 'VIP', builtin: true, color: '#f59e0b', description: 'VIP and executive access' },
  { id: 'blacklist', name: 'Blacklist', builtin: true, color: '#ef4444', description: 'Restricted or banned individuals' },
];

const AUTH_STATUSES = ['authorized', 'unauthorized', 'pending'];

function ensureDirs() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.mkdirSync(IMAGES_DIR, { recursive: true });
}

function readDb() {
  ensureDirs();
  if (!fs.existsSync(DB_PATH)) {
    const initial = { groups: [...BUILTIN_GROUPS], persons: [] };
    fs.writeFileSync(DB_PATH, JSON.stringify(initial, null, 2));
    return initial;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    return {
      groups: Array.isArray(raw.groups) ? raw.groups : [...BUILTIN_GROUPS],
      persons: Array.isArray(raw.persons) ? raw.persons : [],
    };
  } catch {
    return { groups: [...BUILTIN_GROUPS], persons: [] };
  }
}

function writeDb(db) {
  ensureDirs();
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

function readAlerts() {
  ensureDirs();
  if (!fs.existsSync(ALERTS_PATH)) {
    fs.writeFileSync(ALERTS_PATH, JSON.stringify({ alerts: [] }, null, 2));
    return { alerts: [] };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(ALERTS_PATH, 'utf8'));
    return { alerts: Array.isArray(raw.alerts) ? raw.alerts : [] };
  } catch {
    return { alerts: [] };
  }
}

function writeAlerts(data) {
  ensureDirs();
  fs.writeFileSync(ALERTS_PATH, JSON.stringify(data, null, 2));
}

function saveProfileImage(personId, base64Data) {
  if (!base64Data || typeof base64Data !== 'string') return null;
  const match = base64Data.match(/^data:image\/\w+;base64,(.+)$/);
  const buf = Buffer.from(match ? match[1] : base64Data, 'base64');
  if (buf.length < 64) return null;
  const filePath = path.join(IMAGES_DIR, `${personId}.jpg`);
  fs.writeFileSync(filePath, buf);
  return `/api/face/persons/${personId}/image`;
}

function deleteProfileImage(personId) {
  const filePath = path.join(IMAGES_DIR, `${personId}.jpg`);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

function getProfileImagePath(personId) {
  const filePath = path.join(IMAGES_DIR, `${personId}.jpg`);
  return fs.existsSync(filePath) ? filePath : null;
}

function getProfileImageBase64(personId) {
  const filePath = getProfileImagePath(personId);
  if (!filePath) return null;
  return `data:image/jpeg;base64,${fs.readFileSync(filePath).toString('base64')}`;
}

function normalizePerson(p) {
  return {
    id: p.id,
    backendPersonId: p.backendPersonId || null,
    fullName: p.fullName || '',
    personId: p.personId || '',
    groupId: p.groupId || 'employees',
    role: p.role || '',
    contact: {
      email: p.contact?.email || '',
      phone: p.contact?.phone || '',
    },
    department: p.department || '',
    notes: p.notes || '',
    profileImageUrl: p.profileImageUrl || (getProfileImagePath(p.id) ? `/api/face/persons/${p.id}/image` : null),
    authorizationStatus: AUTH_STATUSES.includes(p.authorizationStatus) ? p.authorizationStatus : 'pending',
    createdAt: p.createdAt || new Date().toISOString(),
    lastSeen: p.lastSeen || null,
    embeddingCount: p.embeddingCount || 0,
    enrolledAt: p.enrolledAt || p.createdAt || new Date().toISOString(),
    updatedAt: p.updatedAt || new Date().toISOString(),
  };
}

function listGroups() {
  const db = readDb();
  const builtinIds = new Set(BUILTIN_GROUPS.map((g) => g.id));
  const merged = [...BUILTIN_GROUPS];
  for (const g of db.groups) {
    if (!builtinIds.has(g.id)) merged.push(g);
  }
  return merged;
}

function getGroup(groupId) {
  return listGroups().find((g) => g.id === groupId) || null;
}

function createGroup({ name, color, description }) {
  if (!name || !String(name).trim()) return { ok: false, error: 'Group name is required' };
  const db = readDb();
  const id = `grp_${randomUUID().slice(0, 8)}`;
  const group = {
    id,
    name: String(name).trim(),
    builtin: false,
    color: color || '#64748b',
    description: description || '',
    createdAt: new Date().toISOString(),
  };
  db.groups.push(group);
  writeDb(db);
  return { ok: true, group };
}

function updateGroup(groupId, patch) {
  const db = readDb();
  const idx = db.groups.findIndex((g) => g.id === groupId);
  if (idx < 0) return { ok: false, error: 'Group not found' };
  if (db.groups[idx].builtin && patch.name) {
    return { ok: false, error: 'Built-in group names cannot be changed' };
  }
  if (patch.name) db.groups[idx].name = String(patch.name).trim();
  if (patch.color) db.groups[idx].color = patch.color;
  if (patch.description !== undefined) db.groups[idx].description = patch.description;
  db.groups[idx].updatedAt = new Date().toISOString();
  writeDb(db);
  return { ok: true, group: db.groups[idx] };
}

function deleteGroup(groupId) {
  const builtin = BUILTIN_GROUPS.find((g) => g.id === groupId);
  if (builtin) return { ok: false, error: 'Built-in groups cannot be deleted' };
  const db = readDb();
  const hasPersons = db.persons.some((p) => p.groupId === groupId);
  if (hasPersons) return { ok: false, error: 'Group has enrolled persons — reassign them first' };
  db.groups = db.groups.filter((g) => g.id !== groupId);
  writeDb(db);
  return { ok: true };
}

function listPersons(filters = {}) {
  const db = readDb();
  let list = db.persons.map(normalizePerson);
  const q = (filters.q || '').trim().toLowerCase();
  if (q) {
    list = list.filter(
      (p) =>
        p.fullName.toLowerCase().includes(q) ||
        p.personId.toLowerCase().includes(q) ||
        p.department.toLowerCase().includes(q) ||
        p.role.toLowerCase().includes(q)
    );
  }
  if (filters.groupId) list = list.filter((p) => p.groupId === filters.groupId);
  if (filters.authorizationStatus) list = list.filter((p) => p.authorizationStatus === filters.authorizationStatus);
  const sortBy = filters.sortBy || 'fullName';
  const sortDir = filters.sortDir === 'desc' ? -1 : 1;
  list.sort((a, b) => {
    const av = a[sortBy] ?? '';
    const bv = b[sortBy] ?? '';
    if (av < bv) return -1 * sortDir;
    if (av > bv) return 1 * sortDir;
    return 0;
  });
  return list;
}

function getPerson(personId) {
  const db = readDb();
  const hit = db.persons.find((p) => p.id === personId);
  return hit ? normalizePerson(hit) : null;
}

function createPerson(body = {}) {
  if (!body.fullName || !String(body.fullName).trim()) {
    return { ok: false, error: 'Full name is required' };
  }
  const db = readDb();
  const id = randomUUID();
  const now = new Date().toISOString();
  const person = normalizePerson({
    id,
    backendPersonId: body.backendPersonId || null,
    fullName: String(body.fullName).trim(),
    personId: String(body.personId || '').trim(),
    groupId: getGroup(body.groupId)?.id || 'employees',
    role: String(body.role || '').trim(),
    contact: body.contact || {},
    department: String(body.department || '').trim(),
    notes: String(body.notes || '').trim(),
    authorizationStatus: body.authorizationStatus || 'pending',
    createdAt: now,
    enrolledAt: now,
    updatedAt: now,
    embeddingCount: 0,
    lastSeen: null,
  });
  if (body.profileImage) {
    person.profileImageUrl = saveProfileImage(id, body.profileImage);
  }
  db.persons.push(person);
  writeDb(db);
  return { ok: true, person };
}

function updatePerson(personId, patch = {}) {
  const db = readDb();
  const idx = db.persons.findIndex((p) => p.id === personId);
  if (idx < 0) return { ok: false, error: 'Person not found' };
  const current = db.persons[idx];
  if (patch.fullName !== undefined) current.fullName = String(patch.fullName).trim();
  if (patch.personId !== undefined) current.personId = String(patch.personId).trim();
  if (patch.groupId !== undefined) current.groupId = getGroup(patch.groupId)?.id || current.groupId;
  if (patch.role !== undefined) current.role = String(patch.role).trim();
  if (patch.department !== undefined) current.department = String(patch.department).trim();
  if (patch.notes !== undefined) current.notes = String(patch.notes).trim();
  if (patch.authorizationStatus !== undefined && AUTH_STATUSES.includes(patch.authorizationStatus)) {
    current.authorizationStatus = patch.authorizationStatus;
  }
  if (patch.contact && typeof patch.contact === 'object') {
    current.contact = { ...(current.contact || {}), ...patch.contact };
  }
  if (patch.backendPersonId !== undefined) current.backendPersonId = patch.backendPersonId;
  if (patch.embeddingCount !== undefined) current.embeddingCount = Number(patch.embeddingCount) || 0;
  if (patch.enrolledAt !== undefined) current.enrolledAt = patch.enrolledAt;
  if (patch.profileImage) {
    current.profileImageUrl = saveProfileImage(personId, patch.profileImage);
  }
  if (patch.lastSeen) current.lastSeen = patch.lastSeen;
  current.updatedAt = new Date().toISOString();
  writeDb(db);
  return { ok: true, person: normalizePerson(current) };
}

function deletePerson(personId) {
  const db = readDb();
  const idx = db.persons.findIndex((p) => p.id === personId);
  if (idx < 0) return { ok: false, error: 'Person not found' };
  db.persons.splice(idx, 1);
  writeDb(db);
  deleteProfileImage(personId);
  return { ok: true };
}

function bulkDeletePersons(ids = []) {
  const deleted = [];
  for (const id of ids) {
    const r = deletePerson(id);
    if (r.ok) deleted.push(id);
  }
  return { ok: true, deleted };
}

function recordLastSeen(personId, { cameraId, cameraName, location }) {
  return updatePerson(personId, {
    lastSeen: {
      at: new Date().toISOString(),
      cameraId: cameraId || null,
      cameraName: cameraName || 'Unknown',
      location: location || '—',
    },
  });
}

function importDatabase(payload = {}) {
  const persons = Array.isArray(payload.persons) ? payload.persons : [];
  const groups = Array.isArray(payload.groups) ? payload.groups : [];
  const db = readDb();
  let imported = 0;
  for (const g of groups) {
    if (!g.name || db.groups.some((x) => x.id === g.id)) continue;
    db.groups.push({
      id: g.id || `grp_${randomUUID().slice(0, 8)}`,
      name: g.name,
      builtin: false,
      color: g.color || '#64748b',
      description: g.description || '',
    });
  }
  for (const p of persons) {
    if (!p.fullName) continue;
    const r = createPerson(p);
    if (r.ok) imported += 1;
  }
  return { ok: true, imported, total: db.persons.length };
}

function getStatistics() {
  const persons = listPersons();
  const groups = listGroups();
  const alerts = listAlerts();
  const today = new Date().toDateString();
  const alertsToday = alerts.filter((a) => new Date(a.createdAt).toDateString() === today);
  const byGroup = {};
  for (const g of groups) byGroup[g.id] = 0;
  for (const p of persons) {
    byGroup[p.groupId] = (byGroup[p.groupId] || 0) + 1;
  }
  return {
    totalPersons: persons.length,
    enrolledWithEmbeddings: persons.filter((p) => p.embeddingCount > 0).length,
    totalGroups: groups.length,
    byGroup,
    authorized: persons.filter((p) => p.authorizationStatus === 'authorized').length,
    unauthorized: persons.filter((p) => p.authorizationStatus === 'unauthorized').length,
    pending: persons.filter((p) => p.authorizationStatus === 'pending').length,
    activeAlerts: alerts.filter((a) => a.status === 'active').length,
    alertsToday: alertsToday.length,
    recentRecognitions: persons.filter((p) => p.lastSeen).length,
  };
}

function createAlert(alert = {}) {
  const data = readAlerts();
  const entry = {
    id: `falert-${Date.now()}-${randomUUID().slice(0, 6)}`,
    type: alert.type || 'unknown-face-detected',
    severity: alert.severity || 'warning',
    status: 'active',
    title: alert.title || 'Face alert',
    message: alert.message || '',
    personId: alert.personId || null,
    personName: alert.personName || null,
    groupId: alert.groupId || null,
    cameraId: alert.cameraId || null,
    cameraName: alert.cameraName || 'Unknown camera',
    location: alert.location || '—',
    snapshotEventId: alert.snapshotEventId || null,
    confidence: alert.confidence ?? null,
    createdAt: new Date().toISOString(),
    acknowledgedAt: null,
    acknowledgedBy: null,
  };
  data.alerts.unshift(entry);
  if (data.alerts.length > 500) data.alerts = data.alerts.slice(0, 500);
  writeAlerts(data);

  // Fire-and-forget notification dispatch (email now; WhatsApp/Telegram later).
  // Pass live JPEG only to notify — never persist base64 into face-alerts.json.
  try {
    const alertNotify = require('./alert-notify');
    let snapshotJpeg = alert.snapshotJpeg || null;
    if (typeof snapshotJpeg === 'string' && snapshotJpeg.startsWith('data:image')) {
      snapshotJpeg = snapshotJpeg.replace(/^data:image\/\w+;base64,/, '');
    }
    if (!snapshotJpeg || snapshotJpeg.length < 64) snapshotJpeg = null;
    const forNotify = snapshotJpeg ? { ...entry, snapshotJpeg } : entry;
    Promise.resolve(alertNotify.dispatchAlert(forNotify)).catch((err) => {
      console.warn('[face-store] alert notify:', err.message);
    });
  } catch (err) {
    console.warn('[face-store] alert notify load:', err.message);
  }

  return entry;
}

function listAlerts(filters = {}) {
  const data = readAlerts();
  let list = [...data.alerts];
  if (filters.status) list = list.filter((a) => a.status === filters.status);
  if (filters.type) list = list.filter((a) => a.type === filters.type);
  if (filters.q) {
    const q = filters.q.toLowerCase();
    list = list.filter(
      (a) =>
        (a.title || '').toLowerCase().includes(q) ||
        (a.personName || '').toLowerCase().includes(q) ||
        (a.cameraName || '').toLowerCase().includes(q)
    );
  }
  return list;
}

function getAlert(alertId) {
  return listAlerts().find((a) => a.id === alertId) || null;
}

function acknowledgeAlert(alertId, user = 'operator') {
  const data = readAlerts();
  const idx = data.alerts.findIndex((a) => a.id === alertId);
  if (idx < 0) return { ok: false, error: 'Alert not found' };
  data.alerts[idx].status = 'acknowledged';
  data.alerts[idx].acknowledgedAt = new Date().toISOString();
  data.alerts[idx].acknowledgedBy = user;
  writeAlerts(data);
  return { ok: true, alert: data.alerts[idx] };
}

function bulkAcknowledgeAlerts(ids = [], user = 'operator') {
  const acked = [];
  const data = readAlerts();
  const set = new Set((ids || []).map(String));
  data.alerts.forEach((a, i) => {
    if (!set.has(String(a.id))) return;
    if (a.status === 'acknowledged') return;
    data.alerts[i] = {
      ...a,
      status: 'acknowledged',
      acknowledgedAt: new Date().toISOString(),
      acknowledgedBy: user,
    };
    acked.push(data.alerts[i]);
  });
  writeAlerts(data);
  return { ok: true, acknowledged: acked.length, alerts: acked };
}

/** Remove alerts that belong to a deleted camera. */
function purgeCameraAlerts(cameraId, { name } = {}) {
  const id = String(cameraId || '').trim();
  const nameLower = name ? String(name).trim().toLowerCase() : '';
  if (!id && !nameLower) return { ok: false, removed: 0 };
  const data = readAlerts();
  const before = data.alerts.length;
  data.alerts = data.alerts.filter((a) => {
    if (id && a.cameraId && String(a.cameraId) === id) return false;
    if (nameLower && String(a.cameraName || '').trim().toLowerCase() === nameLower) return false;
    return true;
  });
  const removed = before - data.alerts.length;
  if (removed) writeAlerts(data);
  return { ok: true, removed };
}

function getCandidatesForRecognition() {
  return listPersons()
    .filter((p) => p.embeddingCount > 0)
    .map((p) => ({
      person_id: p.backendPersonId || p.id,
      name: p.fullName,
      groupId: p.groupId,
      authorizationStatus: p.authorizationStatus,
    }));
}

module.exports = {
  listGroups,
  getGroup,
  createGroup,
  updateGroup,
  deleteGroup,
  listPersons,
  getPerson,
  createPerson,
  updatePerson,
  deletePerson,
  bulkDeletePersons,
  recordLastSeen,
  importDatabase,
  getStatistics,
  createAlert,
  listAlerts,
  getAlert,
  acknowledgeAlert,
  bulkAcknowledgeAlerts,
  purgeCameraAlerts,
  getProfileImagePath,
  getProfileImageBase64,
  getCandidatesForRecognition,
  IMAGES_DIR,
};
