const fs = require('fs');
const path = require('path');
const log = require('../utils/logger').child('dbStore');

const PROJECT_ROOT = path.join(__dirname, '../..');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'database.json');
const UPLOADS_DIR = path.join(PROJECT_ROOT, 'uploads');
const CROPS_DIR = path.join(DATA_DIR, 'crops');

// Ensure directories exist
[DATA_DIR, UPLOADS_DIR, CROPS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

function initDB() {
  let dbData = {
    persons: [],
    photos: [],
    events: [],
    cameras: [],
    clusters: [],
    settings: { threshold: 0.60, dis_type: 0 },
  };

  if (fs.existsSync(DB_FILE)) {
    try {
      const existing = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      dbData.persons = existing.persons || [];
      dbData.photos = existing.photos || [];
      dbData.events = existing.events || [];
      dbData.cameras = existing.cameras || [];
      dbData.clusters = existing.clusters || [];
      dbData.settings = existing.settings || { threshold: 0.60, dis_type: 0 };
    } catch (err) {
      log.error({ err }, 'Error reading DB_FILE, creating fresh database');
      fs.writeFileSync(DB_FILE, JSON.stringify(dbData, null, 2));
    }
  } else {
    fs.writeFileSync(DB_FILE, JSON.stringify(dbData, null, 2));
  }
  return dbData;
}

function readDB() {
  try {
    if (!fs.existsSync(DB_FILE)) return initDB();
    const data = fs.readFileSync(DB_FILE, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    log.error({ err }, 'Failed to read database file');
    return { persons: [], photos: [], events: [], cameras: [], clusters: [], settings: { threshold: 0.60, dis_type: 0 } };
  }
}

function writeDB(data) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    log.error({ err }, 'Failed to write database file');
  }
}

module.exports = {
  PROJECT_ROOT,
  DATA_DIR,
  DB_FILE,
  UPLOADS_DIR,
  CROPS_DIR,
  initDB,
  readDB,
  writeDB,
};
