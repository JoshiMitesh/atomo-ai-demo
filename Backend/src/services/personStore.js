const { v4: uuidv4 } = require('uuid');
const { readDB, writeDB, UPLOADS_DIR } = require('./dbStore');
const fs = require('fs');
const path = require('path');
const log = require('../utils/logger').child('person');

const persons = new Map();

function loadFromDB() {
  try {
    const db = readDB();
    if (Array.isArray(db.persons)) {
      db.persons.forEach(p => {
        const id = p.person_id || p.id;
        const pPhotos = (db.photos || []).filter(ph => ph.person_id === id);
        const embeddings = pPhotos.map(ph => ph.embedding).filter(Boolean);
        const cropFilenames = pPhotos.map(ph => ph.filename).filter(Boolean);
        
        persons.set(id, {
          person_id: id,
          id: id,
          name: p.name,
          gender: p.gender || 'Unknown',
          note: p.note || '',
          embeddings: p.embeddings || embeddings,
          crop_filenames: p.crop_filenames || cropFilenames,
          photos: pPhotos.map(ph => ({ id: ph.id || ph.filename, filename: ph.filename })),
          enrolled_at: p.enrolled_at || p.created_at || new Date().toISOString(),
          updated_at: p.updated_at || new Date().toISOString(),
        });
      });
      log.info({ count: persons.size }, 'loaded persons from database file');
    }
  } catch (err) {
    log.error({ err }, 'failed to load persons from database');
  }
}
loadFromDB();

function saveToDB() {
  const db = readDB();
  db.persons = Array.from(persons.values()).map(p => ({
    id: p.person_id,
    person_id: p.person_id,
    name: p.name,
    gender: p.gender,
    note: p.note,
    enrolled_at: p.enrolled_at,
    updated_at: p.updated_at
  }));
  
  // Update photos collection
  const allPhotos = [];
  persons.forEach(p => {
    (p.photos || []).forEach((ph, i) => {
      allPhotos.push({
        id: ph.id || `ph_${p.person_id}_${i}`,
        person_id: p.person_id,
        filename: ph.filename,
        embedding: p.embeddings[i] || null
      });
    });
  });
  db.photos = allPhotos;
  writeDB(db);
}

function createPerson({ name, gender = 'Unknown', note = '' }) {
  if (!name) throw new Error('name is required');
  const id = 'p_' + uuidv4().slice(0, 8);
  const p = {
    person_id: id,
    id: id,
    name,
    gender,
    note,
    embeddings: [],
    crop_filenames: [],
    photos: [],
    enrolled_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  persons.set(id, p);
  saveToDB();
  log.info({ person_id: id, name }, 'created person');
  return p;
}

function getPerson(id) {
  return persons.get(id) || null;
}

function listPersons() {
  return Array.from(persons.values()).map(p => ({
    person_id: p.person_id,
    id: p.person_id,
    name: p.name,
    gender: p.gender,
    note: p.note,
    photos: p.photos || [],
    embedding_count: p.embeddings.length,
    crop_filenames: p.crop_filenames,
    enrolled_at: p.enrolled_at,
    updated_at: p.updated_at
  }));
}

function updatePerson(id, patch) {
  const p = persons.get(id);
  if (!p) throw new Error(`Person ${id} not found`);
  if (patch.name) p.name = patch.name;
  if (patch.gender) p.gender = patch.gender;
  if (patch.note !== undefined) p.note = patch.note;
  p.updated_at = new Date().toISOString();
  saveToDB();
  log.info({ person_id: id }, 'updated person');
  return p;
}

function deletePerson(id) {
  const p = persons.get(id);
  if (!p) throw new Error(`Person ${id} not found`);
  (p.photos || []).forEach(ph => {
    const filePath = path.join(UPLOADS_DIR, ph.filename);
    if (fs.existsSync(filePath)) {
      try { fs.unlinkSync(filePath); } catch (e) {}
    }
  });
  persons.delete(id);
  saveToDB();
  log.info({ person_id: id }, 'deleted person');
}

function deletePhoto(photoId) {
  let foundPerson = null;
  let photoIndex = -1;

  for (const p of persons.values()) {
    const idx = (p.photos || []).findIndex(ph => ph.id === photoId || ph.filename === photoId);
    if (idx !== -1) {
      foundPerson = p;
      photoIndex = idx;
      break;
    }
  }

  if (!foundPerson || photoIndex === -1) return false;

  const photoObj = foundPerson.photos[photoIndex];
  const filePath = path.join(UPLOADS_DIR, photoObj.filename);
  if (fs.existsSync(filePath)) {
    try { fs.unlinkSync(filePath); } catch (e) {}
  }

  foundPerson.photos.splice(photoIndex, 1);
  foundPerson.embeddings.splice(photoIndex, 1);
  foundPerson.crop_filenames.splice(photoIndex, 1);
  foundPerson.updated_at = new Date().toISOString();
  saveToDB();
  log.info({ photoId, person_id: foundPerson.person_id }, 'deleted photo');
  return true;
}

function addEmbeddings(id, embeddings, cropFilenames = []) {
  const p = persons.get(id);
  if (!p) throw new Error(`Person ${id} not found`);
  
  for (let i = 0; i < embeddings.length; i++) {
    const fn = cropFilenames[i] || `photo_${Date.now()}_${i}.jpg`;
    p.embeddings.push(embeddings[i]);
    p.crop_filenames.push(fn);
    if (!p.photos) p.photos = [];
    p.photos.push({ id: Date.now().toString(36) + Math.random().toString(36).substr(2, 4), filename: fn });
  }

  p.updated_at = new Date().toISOString();
  saveToDB();
  log.debug({ person_id: id, added: embeddings.length }, 'added embeddings');
  return p;
}

function getCandidatesPayload() {
  return Array.from(persons.values())
    .filter(p => p.embeddings.length > 0)
    .map(p => ({ person_id: p.person_id, name: p.name, embeddings: p.embeddings }));
}

module.exports = {
  createPerson,
  getPerson,
  listPersons,
  updatePerson,
  deletePerson,
  deletePhoto,
  addEmbeddings,
  getCandidatesPayload
};
