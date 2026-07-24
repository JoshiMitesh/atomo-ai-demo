const fs = require('fs');
const path = require('path');
const { readDB, writeDB, CROPS_DIR } = require('./dbStore');
const log = require('../utils/logger').child('eventStore');

let events = [];

function loadEvents() {
  const db = readDB();
  events = db.events || [];
}
loadEvents();

function saveEvents() {
  const db = readDB();
  db.events = events;
  writeDB(db);
}

function getEvents(limit = 100) {
  return events
    .slice()
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .slice(0, limit);
}

function addEvent(personId, personName, score, cropFilename, isKnown, cameraId = null, cameraName = 'Live Stream') {
  const newEvent = {
    id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
    timestamp: new Date().toISOString(),
    person_id: personId,
    person_name: personName,
    score: score,
    crop_filename: cropFilename,
    is_known: isKnown,
    camera_id: cameraId,
    camera_name: cameraName
  };

  events.push(newEvent);

  if (events.length > 1000) {
    const removed = events.shift();
    if (removed && removed.crop_filename) {
      const cropPath = path.join(CROPS_DIR, removed.crop_filename);
      if (fs.existsSync(cropPath)) {
        try { fs.unlinkSync(cropPath); } catch (e) {}
      }
    }
  }

  saveEvents();
  log.debug({ eventId: newEvent.id, personId, isKnown }, 'Added new recognition event');
  return newEvent;
}

function updateEvent(eventId, updates) {
  const idx = events.findIndex(e => e.id === eventId);
  if (idx !== -1) {
    events[idx] = { ...events[idx], ...updates };
    saveEvents();
    log.debug({ eventId, updates }, 'Updated recognition event');
    return events[idx];
  }
  return null;
}

function getEvent(eventId) {
  return events.find(e => e.id === eventId) || null;
}

function updateEventPerson(eventId, personId, personName) {
  const idx = events.findIndex(e => e.id === eventId);
  if (idx !== -1) {
    events[idx] = {
      ...events[idx],
      person_id: personId,
      person_name: personName,
      is_known: true,
      score: 1.0
    };
    saveEvents();
    log.debug({ eventId, personId, personName }, 'Reassigned event to known person');
    return events[idx];
  }
  return null;
}

function clearEvents() {
  events.forEach(ev => {
    if (ev.crop_filename) {
      const cropPath = path.join(CROPS_DIR, ev.crop_filename);
      if (fs.existsSync(cropPath)) {
        try { fs.unlinkSync(cropPath); } catch (e) {}
      }
    }
  });
  events = [];
  saveEvents();
  log.info('Cleared all recognition events');
  return true;
}

module.exports = {
  getEvents,
  getEvent,
  addEvent,
  updateEvent,
  updateEventPerson,
  clearEvents
};
