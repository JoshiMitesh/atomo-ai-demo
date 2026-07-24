/**
 * Send stream / test progress to the Node terminal via /api/cameras/stream-log.
 */
(function () {
  function sessionUrl(path) {
    const sid = sessionStorage.getItem('atomoSessionId');
    return sid ? `${path}?sessionId=${encodeURIComponent(sid)}` : path;
  }

  function report(payload) {
    const body = {
      source: payload.source || 'ui',
      step: payload.step || 'unknown',
      level: payload.level || 'info',
      cameraId: payload.cameraId || null,
      cameraName: payload.cameraName || null,
      message: payload.message || '',
      why: payload.why || null,
      mode: payload.mode || null,
      url: payload.url || null,
      detail: payload.detail || null,
      hint: payload.hint || null,
    };
    try {
      // Prefer sendBeacon so logs still flush on navigation; fall back to fetch.
      const url = sessionUrl('/api/cameras/stream-log');
      const json = JSON.stringify(body);
      if (navigator.sendBeacon) {
        const blob = new Blob([json], { type: 'application/json' });
        if (navigator.sendBeacon(url, blob)) return;
      }
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: json,
        keepalive: true,
      }).catch(() => {});
    } catch {
      /* ignore */
    }
  }

  window.CameraStreamLog = { report };
})();
