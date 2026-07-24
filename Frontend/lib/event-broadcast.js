/**
 * Dashboard WebSocket broadcast for real-time detection events + metrics.
 */

const clients = new Set();

function addClient(ws, slug = 'person') {
  ws._slug = slug;
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
}

function broadcast(slug, message) {
  const data = typeof message === 'string' ? message : JSON.stringify(message);
  for (const ws of clients) {
    if (ws._slug === slug && ws.readyState === 1) {
      try {
        ws.send(data);
      } catch {
        clients.delete(ws);
      }
    }
  }
}

function broadcastPersonUpdate(payload, newEvents = []) {
  const slimEvents = (newEvents || []).map((e) => {
    if (!e || typeof e !== 'object') return e;
    const { snapshotJpeg, ...rest } = e;
    return rest;
  });
  const slimPayload = payload && typeof payload === 'object'
    ? {
        ...payload,
        events: Array.isArray(payload.events)
          ? payload.events.map((e) => {
              if (!e || typeof e !== 'object') return e;
              const { snapshotJpeg, ...rest } = e;
              return rest;
            })
          : payload.events,
      }
    : payload;
  broadcast('person', {
    type: 'person_update',
    payload: slimPayload,
    newEvents: slimEvents,
    ts: Date.now(),
  });
}

function broadcastFaceUpdate(payload, newEvents = [], extras = {}) {
  broadcast('face', {
    type: 'face_update',
    payload,
    newEvents,
    ...extras,
    ts: Date.now(),
  });
}

module.exports = {
  addClient,
  broadcast,
  broadcastPersonUpdate,
  broadcastFaceUpdate,
};
