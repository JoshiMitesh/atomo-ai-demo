function jitter(value, range = 1, min = 0, max = Infinity) {
  const delta = (Math.random() * range * 2) - range;
  return Math.max(min, Math.min(max, Math.round((value + delta) * 10) / 10));
}

function boardHost() {
  const configured = process.env.VISION_PUBLIC_HOST
    || process.env.MEDIA_PUBLIC_HOST
    || process.env.BOARD_PUBLIC_HOST
    || process.env.BOARD_IP
    || '';
  if (!configured) return '';
  try {
    return new URL(configured.includes('://') ? configured : `http://${configured}`).hostname;
  } catch {
    return configured.replace(/^https?:\/\//i, '').split('/')[0].split(':')[0];
  }
}

function normalizeMediaUrl(url) {
  if (!url) return null;
  const host = boardHost();
  const raw = String(url).trim();
  if (!host) return raw;
  try {
    const parsed = new URL(raw);
    if (['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(parsed.hostname)) {
      parsed.hostname = host;
    }
    if (process.env.MEDIA_PUBLIC_PROTOCOL) {
      parsed.protocol = `${process.env.MEDIA_PUBLIC_PROTOCOL.replace(/:$/, '')}:`;
    }
    return parsed.toString();
  } catch {
    return raw
      .replace(/localhost/gi, host)
      .replace(/127\.0\.0\.1/g, host)
      .replace(/0\.0\.0\.0/g, host);
  }
}

function sanitizeCamera(camera) {
  if (!camera) return null;
  const { password, ...safe } = camera;
  return {
    ...safe,
    hlsUrl: normalizeMediaUrl(safe.hlsUrl),
    whepUrl: normalizeMediaUrl(safe.whepUrl),
    faceHlsUrl: normalizeMediaUrl(safe.faceHlsUrl),
    faceWhepUrl: normalizeMediaUrl(safe.faceWhepUrl),
    hasCredentials: Boolean(camera.username || password),
  };
}

function localMjpegPath(cameraId) {
  if (!cameraId) return null;
  return `/api/cameras/${encodeURIComponent(cameraId)}/preview.mjpeg`;
}

function getPreviewConfig(camera) {
  const url = String(camera.rtspUrl || camera.url || camera.streamUrl || '').trim();
  const type = camera.type || 'rtsp';
  const boardHls = normalizeMediaUrl(camera.hlsUrl || camera.faceHlsUrl);
  const boardWhep = normalizeMediaUrl(camera.whepUrl || camera.faceWhepUrl);
  const mjpegUrl = url && /^rtsp:\/\//i.test(url) ? localMjpegPath(camera.id) : null;

  if (boardWhep || boardHls) {
    return {
      mode: 'whep',
      url: boardWhep,
      hlsUrl: boardHls,
      whepUrl: boardWhep,
      mjpegUrl,
      simulated: false,
      label: 'Live WebRTC stream',
    };
  }

  if (type === 'http' && /^https?:\/\//i.test(url)) {
    return { mode: 'http', url, mjpegUrl: null, simulated: false };
  }

  if (type === 'video-file' && /\.(mp4|webm|ogg)(\?|$)/i.test(url)) {
    return { mode: 'video', url, mjpegUrl: null, simulated: false };
  }

  // Browsers cannot play RTSP. Local ffmpeg MJPEG uses TCP
  // (same as: ffplay -rtsp_transport tcp "<url>").
  if (mjpegUrl) {
    return {
      mode: 'mjpeg',
      url: mjpegUrl,
      mjpegUrl,
      simulated: false,
      label: 'Live RTSP preview (TCP)',
    };
  }

  if (url) {
    return {
      mode: 'edge',
      url: null,
      mjpegUrl: null,
      simulated: true,
      label: 'Connecting stream — register camera on vision board',
    };
  }

  return {
    mode: 'edge',
    url: null,
    mjpegUrl: null,
    simulated: true,
    label: 'No stream URL configured',
  };
}

function getLiveAnalytics(camera) {
  const v = camera.validation || {};
  const fpsTarget = Number(camera.fpsLimit) || v.fps || 25;
  const fps = jitter(fpsTarget, 1.2, 1, fpsTarget);
  const latencyMs = jitter(v.latencyMs || 128, 18, 40, 400);
  const packetLoss = jitter(0.3, 0.25, 0, 5);
  const bitrate = jitter(2.6, 0.4, 0.5, 12);
  const uptimeSecs = Math.floor(Date.now() / 1000) - Math.floor(Math.random() * 86400);

  let streamHealth = 'good';
  if (camera.status !== 'online' || packetLoss > 2 || latencyMs > 250) streamHealth = 'poor';
  else if (packetLoss > 0.8 || latencyMs > 160 || Math.abs(fps - fpsTarget) > 2) streamHealth = 'fair';

  return {
    timestamp: new Date().toISOString(),
    fps,
    fpsTarget,
    bitrateMbps: bitrate,
    latencyMs: Math.round(latencyMs),
    jitterMs: Math.round(jitter(8, 4, 1, 40)),
    packetLossPercent: packetLoss,
    codec: v.codec || 'H.264',
    resolution: camera.resolution || v.resolution || '1920x1080',
    hasAudio: v.hasAudio !== false,
    uptimeSeconds: uptimeSecs,
    framesReceived: Math.floor(uptimeSecs * fps * 0.98),
    frameDrops: Math.floor(Math.random() * 4),
    streamHealth,
    recording: Boolean(camera.recording),
    aiEventsLastHour: Math.floor(Math.random() * 18),
    alertsToday: Math.floor(Math.random() * 6),
    reconnectCount: v.reconnectOk === false ? 1 : 0,
    bandwidthInKbps: Math.round(bitrate * 1024 * 0.7),
    bandwidthOutKbps: Math.round(bitrate * 1024 * 0.15),
  };
}

function getLiveViewPayload(camera) {
  return {
    camera: sanitizeCamera(camera),
    preview: getPreviewConfig(camera),
    analytics: getLiveAnalytics(camera),
  };
}

module.exports = {
  getLiveViewPayload,
  getLiveAnalytics,
  sanitizeCamera,
  normalizeMediaUrl,
};
