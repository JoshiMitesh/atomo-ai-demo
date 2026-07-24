/**
 * Local RTSP → MJPEG preview via ffmpeg (TCP transport).
 * Hikvision / many IP cams need -rtsp_transport tcp; browsers cannot play RTSP.
 */

const { spawn } = require('child_process');

const sessions = new Map();

function buildFfmpegArgs(rtspUrl) {
  return [
    '-hide_banner',
    '-loglevel', 'error',
    '-rtsp_transport', 'tcp',
    '-timeout', '5000000',
    '-i', rtspUrl,
    '-an',
    '-vf', 'scale=1280:-2',
    '-q:v', '6',
    '-r', '10',
    '-f', 'mpjpeg',
    'pipe:1',
  ];
}

function stopSession(cameraId) {
  const sess = sessions.get(cameraId);
  if (!sess) return;
  sessions.delete(cameraId);
  try {
    sess.proc.stdout.removeAllListeners();
    sess.proc.stderr.removeAllListeners();
    sess.proc.removeAllListeners();
  } catch {
    /* ignore */
  }
  try {
    sess.proc.kill('SIGTERM');
  } catch {
    /* ignore */
  }
  setTimeout(() => {
    try {
      if (!sess.proc.killed) sess.proc.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }, 1500);
  for (const res of sess.clients) {
    try {
      if (!res.writableEnded) res.end();
    } catch {
      /* ignore */
    }
  }
}

function attachClient(cameraId, rtspUrl, res) {
  let sess = sessions.get(cameraId);

  if (!sess || sess.rtspUrl !== rtspUrl) {
    if (sess) stopSession(cameraId);

    const proc = spawn('ffmpeg', buildFfmpegArgs(rtspUrl), {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    sess = {
      cameraId,
      rtspUrl,
      proc,
      clients: new Set(),
      startedAt: Date.now(),
      lastError: '',
      headersSent: new WeakSet(),
    };
    sessions.set(cameraId, sess);

    proc.stderr.on('data', (buf) => {
      const msg = String(buf || '').trim();
      if (msg) {
        sess.lastError = msg.slice(0, 400);
        console.warn(`[rtsp-preview] ${cameraId}:`, msg.slice(0, 200));
      }
    });

    proc.stdout.on('data', (chunk) => {
      for (const client of [...sess.clients]) {
        try {
          if (client.writableEnded) {
            sess.clients.delete(client);
            continue;
          }
          if (!sess.headersSent.has(client)) {
            client.writeHead(200, {
              'Content-Type': 'multipart/x-mixed-replace; boundary=ffmpeg',
              'Cache-Control': 'no-cache, no-store, must-revalidate',
              Pragma: 'no-cache',
              Connection: 'close',
              'X-Accel-Buffering': 'no',
            });
            sess.headersSent.add(client);
          }
          client.write(chunk);
        } catch {
          sess.clients.delete(client);
        }
      }
    });

    proc.on('exit', (code, signal) => {
      const current = sessions.get(cameraId);
      if (current?.proc === proc) {
        console.warn(`[rtsp-preview] ${cameraId} exited code=${code} signal=${signal}`);
        for (const client of [...current.clients]) {
          try {
            if (!current.headersSent.has(client) && !client.headersSent) {
              client.status(502).json({
                error: 'RTSP preview failed',
                detail: current.lastError || `ffmpeg exited (${code ?? signal})`,
                hint: 'Use RTSP over TCP, e.g. ffplay -rtsp_transport tcp "<url>"',
              });
            } else if (!client.writableEnded) {
              client.end();
            }
          } catch {
            /* ignore */
          }
        }
        stopSession(cameraId);
      }
    });

    proc.on('error', (err) => {
      sess.lastError = err.message;
      console.warn(`[rtsp-preview] ${cameraId} spawn error:`, err.message);
      stopSession(cameraId);
    });
  }

  sess.clients.add(res);
  // If ffmpeg already running, headers go out on next chunk.
  // Fail fast if process dies before first frame.
  const failTimer = setTimeout(() => {
    if (res.headersSent || res.writableEnded) return;
    if (!sessions.get(cameraId)?.clients.has(res)) return;
    try {
      res.status(504).json({
        error: 'RTSP preview timeout',
        detail: sess.lastError || 'No frames from camera yet',
        hint: 'Confirm the camera allows another RTSP TCP client (ffplay -rtsp_transport tcp).',
      });
    } catch {
      /* ignore */
    }
    sess.clients.delete(res);
  }, 12000);

  const cleanup = () => {
    clearTimeout(failTimer);
    sess.clients.delete(res);
    if (sess.clients.size === 0) {
      setTimeout(() => {
        const still = sessions.get(cameraId);
        if (still && still.clients.size === 0) stopSession(cameraId);
      }, 4000);
    }
  };

  res.on('close', cleanup);
  res.on('finish', cleanup);
  res.on('error', cleanup);

  return sess;
}

function probeRtspTcp(rtspUrl, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const proc = spawn(
      'ffprobe',
      [
        '-v', 'error',
        '-rtsp_transport', 'tcp',
        '-timeout', String(Math.min(timeoutMs, 8000) * 1000),
        '-select_streams', 'v:0',
        '-show_entries', 'stream=codec_name,width,height,avg_frame_rate',
        '-of', 'json',
        rtspUrl,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      resolve({ ok: false, error: 'Probe timed out (RTSP TCP)' });
    }, timeoutMs);

    proc.stdout.on('data', (d) => {
      stdout += String(d);
    });
    proc.stderr.on('data', (d) => {
      stderr += String(d);
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: err.message || 'ffprobe failed' });
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const msg = (stderr || stdout || 'ffprobe failed').trim().slice(0, 300);
        resolve({ ok: false, error: msg || `ffprobe exited ${code}` });
        return;
      }
      try {
        const data = JSON.parse(stdout || '{}');
        const stream = data.streams?.[0] || {};
        resolve({
          ok: true,
          codec: stream.codec_name || null,
          width: stream.width || null,
          height: stream.height || null,
          avgFrameRate: stream.avg_frame_rate || null,
        });
      } catch {
        resolve({ ok: true, codec: null, width: null, height: null });
      }
    });
  });
}

function getSessionStatus(cameraId) {
  const sess = sessions.get(cameraId);
  if (!sess) return null;
  return {
    cameraId,
    clients: sess.clients.size,
    startedAt: sess.startedAt,
    lastError: sess.lastError || null,
  };
}

module.exports = {
  attachClient,
  stopSession,
  probeRtspTcp,
  getSessionStatus,
};
