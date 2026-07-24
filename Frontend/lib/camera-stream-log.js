/**
 * Human-readable camera / stream logs for the Node terminal.
 * Keep messages short and plain so failures are easy to spot.
 */

const CHECK_LABELS = {
  streamReachable: 'Stream reachable',
  credentialsValid: 'Credentials valid',
  frameReceived: 'Frame received',
  resolutionDetected: 'Resolution detected',
  fpsDetected: 'FPS detected',
  codecDetected: 'Codec detected',
  latencyMeasured: 'Latency measured',
  audioPresence: 'Audio presence',
  reconnectCapability: 'Reconnect capability',
};

const liveSyncLast = new Map();

function stamp() {
  return new Date().toISOString().replace('T', ' ').replace('Z', '');
}

function line(text = '') {
  return `  ${text}`;
}

function printBlock(title, rows, level = 'info') {
  const bar = '═'.repeat(56);
  const out = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  const body = [
    '',
    bar,
    `  [${stamp()}]  ${title}`,
    bar,
    ...rows.map((r) => line(r)),
    bar,
    '',
  ].join('\n');
  out(body);
}

function maskUrl(url) {
  if (!url) return '(empty)';
  return String(url).replace(/:([^:@/]+)@/, ':***@');
}

function logValidateStart(body = {}) {
  printBlock('CAMERA TEST — started', [
    `Name: ${body.name || '(no name)'}`,
    `Type: ${body.type || 'rtsp'}`,
    `URL:  ${maskUrl(body.rtspUrl || body.streamUrl || '')}`,
  ]);
}

function logValidateResult(body = {}, result = {}, extra = {}) {
  const ok = Boolean(result.success);
  const rows = [
    `Result: ${ok ? 'PASS ✓' : 'FAIL ✗'}`,
    `Name:   ${body.name || '(no name)'}`,
    `URL:    ${maskUrl(body.rtspUrl || body.streamUrl || '')}`,
  ];

  if (!ok) {
    rows.push(`Why:    ${result.error || 'Validation failed'}`);
  }

  if (result.detected) {
    const d = result.detected;
    rows.push(
      `Detected: ${d.resolution || '?'} · ${d.fps || '?'} fps · ${d.codec || '?'} · ${d.latencyMs != null ? `${d.latencyMs} ms` : '?'}`,
    );
  }

  if (extra.probe) {
    if (extra.probe.ok) {
      rows.push(
        `RTSP TCP probe: OK (${extra.probe.width || '?'}x${extra.probe.height || '?'} ${extra.probe.codec || ''})`.trim(),
      );
    } else {
      rows.push(`RTSP TCP probe: FAILED — ${extra.probe.error || 'unknown'}`);
      rows.push('Hint: try  ffplay -rtsp_transport tcp "<url>"');
    }
  }

  const checks = result.checks || {};
  const checkKeys = Object.keys(CHECK_LABELS);
  if (checkKeys.some((k) => checks[k])) {
    rows.push('Checks:');
    for (const key of checkKeys) {
      const item = checks[key];
      if (!item) continue;
      rows.push(`  ${item.ok ? '✓' : '✗'} ${CHECK_LABELS[key]} — ${item.message || ''}`);
    }
  }

  if (ok) {
    rows.push('Next: click Save camera, then Start stream on the camera card.');
  }

  printBlock(ok ? 'CAMERA TEST — PASS' : 'CAMERA TEST — FAIL', rows, ok ? 'info' : 'error');
}

function logCameraSaved(camera = {}, extras = {}) {
  printBlock('CAMERA SAVED', [
    `ID:    ${camera.id || '?'}`,
    `Name:  ${camera.name || '?'}`,
    `URL:   ${maskUrl(camera.rtspUrl)}`,
    `Board: ${camera.backendId ? `registered (${camera.backendId})` : 'NOT registered yet'}`,
    `WHEP:  ${camera.whepUrl || '(none — stream may not play until board sync)'}`,
    `HLS:   ${camera.hlsUrl || '(none)'}`,
    extras.boardError ? `Board sync problem: ${extras.boardError}` : null,
    extras.assignedSlug ? `Assigned to detection tab: ${extras.assignedSlug}` : null,
  ].filter(Boolean));
}

function logLiveSync(camera = {}, preview = {}, opts = {}) {
  const mode = preview?.mode || '(unknown)';
  const simulated = Boolean(preview?.simulated);
  const hasPlayable = Boolean(preview?.url || preview?.whepUrl || preview?.hlsUrl || preview?.mjpegUrl)
    && !simulated;

  const camKey = camera.id || camera.name || '?';
  const stateKey = `${hasPlayable}|${mode}|${camera.backendId || ''}|${preview?.whepUrl || ''}|${opts.syncError || ''}`;
  const prev = liveSyncLast.get(camKey);
  const now = Date.now();
  // Avoid spam from connect-retry loops: only re-log if state changed or 20s passed, always log failures.
  const shouldSkip = prev
    && prev.stateKey === stateKey
    && hasPlayable
    && !opts.syncError
    && (now - prev.at < 20000);
  if (shouldSkip) return { hasPlayable, mode, simulated };
  liveSyncLast.set(camKey, { stateKey, at: now });

  const rows = [
    `Camera: ${camera.name || camera.id || '?'} (${camera.id || '?'})`,
    `Sync:   ${opts.sync ? 'yes (re-register on board if needed)' : 'no'}`,
    `Mode:   ${mode}${simulated ? ' (simulated / not real yet)' : ''}`,
    `Board ID: ${camera.backendId || '(missing)'}`,
    `WHEP:  ${preview?.whepUrl || camera.whepUrl || '(none)'}`,
    `HLS:   ${preview?.hlsUrl || camera.hlsUrl || '(none)'}`,
    `MJPEG: ${preview?.mjpegUrl || '(none)'}`,
    `RTSP:  ${maskUrl(camera.rtspUrl)}`,
  ];

  if (hasPlayable) {
    rows.push('Status: playable URLs ready for the browser');
    printBlock('START STREAM — live URLs ready', rows);
  } else {
    rows.push('Status: NO playable stream URL yet');
    rows.push('Why stream may not start:');
    if (!camera.rtspUrl) rows.push('  • Camera has no RTSP URL');
    if (!camera.backendId) rows.push('  • Camera not registered on vision board (no backendId)');
    if (!camera.whepUrl && !camera.hlsUrl) {
      rows.push('  • No WHEP/HLS from board — is MediaMTX / vision board running?');
    }
    if (simulated) rows.push('  • Preview is still simulated (waiting for board)');
    if (opts.syncError) rows.push(`  • Board sync error: ${opts.syncError}`);
    printBlock('START STREAM — URLs NOT ready', rows, 'warn');
  }

  return { hasPlayable, mode, simulated };
}

function logBoardSync(camera = {}, info = {}) {
  const rows = [
    `Camera: ${camera.name || camera.id}`,
    `Board reachable: ${info.reachable === false ? 'NO' : 'yes'}`,
    info.action ? `Action: ${info.action}` : null,
    info.backendId ? `Board ID: ${info.backendId}` : null,
    info.whepUrl ? `WHEP: ${info.whepUrl}` : null,
    info.hlsUrl ? `HLS: ${info.hlsUrl}` : null,
    info.error ? `Problem: ${info.error}` : null,
    info.hint ? `Hint: ${info.hint}` : null,
  ].filter(Boolean);

  const level = info.error || info.reachable === false ? 'warn' : 'info';
  printBlock(info.error || info.reachable === false ? 'BOARD SYNC — problem' : 'BOARD SYNC', rows, level);
}

function logDetectionStart(kind, cameraId, result = {}, camera = {}) {
  const ok = Boolean(result.ok);
  const rows = [
    `Kind:   ${kind}`,
    `Camera: ${camera.name || cameraId} (${cameraId})`,
    `Result: ${ok ? 'OK' : 'FAILED'}`,
    result.backendCameraId ? `Board camera: ${result.backendCameraId}` : null,
    result.wsUrl ? `WS: ${result.wsUrl}` : null,
    !ok ? `Why: ${result.error || result.backendError || 'unknown'}` : null,
    !ok && result.backendConnected === false ? 'Hint: vision board may be offline or camera not registered' : null,
  ].filter(Boolean);
  printBlock(
    ok ? `${kind.toUpperCase()} DETECTION — started` : `${kind.toUpperCase()} DETECTION — failed to start`,
    rows,
    ok ? 'info' : 'error',
  );
}

function logClientEvent(payload = {}) {
  const level = payload.level === 'error' ? 'error' : payload.level === 'warn' ? 'warn' : 'info';
  const rows = [
    `From:   browser (${payload.source || 'ui'})`,
    `Step:   ${payload.step || '?'}`,
    `Camera: ${payload.cameraName || payload.cameraId || '(none)'}`,
    payload.message ? `Message: ${payload.message}` : null,
    payload.why ? `Why:     ${payload.why}` : null,
    payload.mode ? `Mode:    ${payload.mode}` : null,
    payload.url ? `URL:     ${maskUrl(payload.url)}` : null,
    payload.detail ? `Detail:  ${typeof payload.detail === 'string' ? payload.detail : JSON.stringify(payload.detail)}` : null,
    payload.hint ? `Hint:    ${payload.hint}` : null,
  ].filter(Boolean);

  const title = level === 'error'
    ? 'BROWSER STREAM — problem'
    : level === 'warn'
      ? 'BROWSER STREAM — warning'
      : 'BROWSER STREAM';
  printBlock(title, rows, level);
}

module.exports = {
  logValidateStart,
  logValidateResult,
  logCameraSaved,
  logLiveSync,
  logBoardSync,
  logDetectionStart,
  logClientEvent,
  maskUrl,
  CHECK_LABELS,
};
