/**
 * Sync face enrollment to the vision board so live recognition can match enrolled persons.
 */

const { apiJson, apiFetch, isReachable, createVisionClient } = require('./vision-api');

const faceClient = createVisionClient(
  process.env.VISION_FACE_API_URL || process.env.VISION_API_URL || process.env.BACKEND_API_URL,
  { label: 'face-enroll' },
);

function decodeBase64Image(data) {
  if (!data || typeof data !== 'string') return null;
  const match = data.match(/^data:image\/\w+;base64,(.+)$/);
  const buf = Buffer.from(match ? match[1] : data, 'base64');
  return buf.length >= 64 ? buf : null;
}

async function getBoardWorkerStatus() {
  try {
    const status = await faceClient.apiJson('/api/face/worker/status');
    return { running: Boolean(status?.running) };
  } catch {
    return { running: false };
  }
}

async function findBoardPerson(person) {
  if (person?.backendPersonId) {
    try {
      const bp = await faceClient.apiJson(`/api/face/persons/${encodeURIComponent(person.backendPersonId)}`);
      return bp;
    } catch {
      /* fall through */
    }
  }
  try {
    const list = await faceClient.apiJson('/api/face/persons');
    if (!Array.isArray(list)) return null;
    return list.find((p) => p.name === person.fullName) || null;
  } catch {
    return null;
  }
}

async function enrollImageOnBoard(boardPersonId, imageBase64) {
  const buf = decodeBase64Image(imageBase64);
  if (!buf) throw new Error('Invalid enrollment image');

  const form = new FormData();
  form.append('image', new Blob([buf], { type: 'image/jpeg' }), 'enroll.jpg');

  const res = await faceClient.apiFetch(
    `/api/face/persons/${encodeURIComponent(boardPersonId)}/enroll/image`,
    { method: 'POST', body: form },
  );

  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
  }
  if (!res.ok) {
    const msg = data?.error || data?.message || `Board enroll failed (${res.status})`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function ensureBoardPerson(person) {
  if (person.backendPersonId) {
    try {
      const existing = await faceClient.apiJson(`/api/face/persons/${encodeURIComponent(person.backendPersonId)}`);
      if (existing?.person_id) return existing.person_id;
    } catch {
      /* create fresh if missing */
    }
  }

  const existing = await findBoardPerson(person);
  if (existing?.person_id) return existing.person_id;

  const created = await faceClient.apiJson('/api/face/persons', {
    method: 'POST',
    body: {
      name: person.fullName,
      note: person.notes || person.department || '',
    },
  });
  if (!created?.person_id) throw new Error('Board did not return person_id');
  return created.person_id;
}

async function syncPersonEnrollToBoard(person, imageBase64) {
  if (!(await faceClient.isReachable())) {
    return {
      ok: false,
      error: 'Vision board offline — start backend on board',
      boardReachable: false,
    };
  }

  try {
    const boardPersonId = await ensureBoardPerson(person);
    const result = await enrollImageOnBoard(boardPersonId, imageBase64);
    return {
      ok: true,
      boardReachable: true,
      backendPersonId: boardPersonId,
      embeddingCount: result.embedding_count || 1,
      message: result.message || 'Embedding added on board',
    };
  } catch (err) {
    return {
      ok: false,
      boardReachable: true,
      error: err.message || 'Could not enroll on board',
    };
  }
}

async function verifyPersonOnBoard(person) {
  const localEmb = person.embeddingCount || 0;
  const reachable = await faceClient.isReachable();
  if (!reachable) {
    return {
      person,
      localEmbeddings: localEmb,
      boardEmbeddings: 0,
      boardPersonFound: false,
      boardReachable: false,
      workerRunning: false,
      readyForRecognition: false,
      status: localEmb > 0 ? 'api_disconnected' : 'no_face_data',
      message: localEmb > 0
        ? 'Face saved locally — vision board offline, cannot sync for recognition'
        : 'No face embedding saved — enroll again with a clear frontal photo',
    };
  }

  const worker = await getBoardWorkerStatus();
  let boardPerson = null;
  try {
    boardPerson = await findBoardPerson(person);
  } catch {
    boardPerson = null;
  }

  const boardEmb = boardPerson?.embedding_count || 0;
  const boardFound = Boolean(boardPerson?.person_id);
  const ready = boardEmb > 0 && worker.running;

  let message = '';
  let status = 'not_on_board';
  if (ready) {
    message = `${person.fullName} is enrolled on board and ready for live recognition`;
    status = 'ready';
  } else if (!boardFound || boardEmb === 0) {
    message = 'Face not on board yet — click Re-sync to board after enrollment';
    status = 'not_on_board';
  } else if (!worker.running) {
    message = 'Enrolled on board — start face recognition on a camera to match this person';
    status = 'worker_off';
  }

  return {
    person,
    localEmbeddings: localEmb,
    boardEmbeddings: boardEmb,
    boardPersonFound: boardFound,
    boardPersonId: boardPerson?.person_id || person.backendPersonId || null,
    boardReachable: true,
    workerRunning: worker.running,
    readyForRecognition: ready,
    status,
    message,
  };
}

async function resyncPersonToBoard(person, faceStore) {
  const image = faceStore.getProfileImageBase64(person.id);
  if (!image) {
    return { ok: false, error: 'No profile image saved — enroll again with a photo' };
  }
  const result = await syncPersonEnrollToBoard(person, image);
  if (!result.ok) return result;

  const updated = faceStore.updatePerson(person.id, {
    backendPersonId: result.backendPersonId,
    embeddingCount: Math.max(person.embeddingCount || 0, result.embeddingCount || 1),
    enrolledAt: person.enrolledAt || new Date().toISOString(),
  });

  return {
    ok: true,
    person: updated.person,
    embeddingCount: result.embeddingCount,
    backendPersonId: result.backendPersonId,
    message: result.message,
  };
}

module.exports = {
  syncPersonEnrollToBoard,
  verifyPersonOnBoard,
  resyncPersonToBoard,
  isReachable,
};
