/**
 * WHEP WebRTC player — low-latency MediaMTX preview (<300ms glass-to-glass).
 */
(function (global) {
  async function connectWhep(whepUrl, videoEl, options = {}) {
    if (!whepUrl || !videoEl) throw new Error('whepUrl and video element required');

    const pc = new RTCPeerConnection({
      // Reliable default: keep STUN, but don't block UX waiting.
      iceServers: options.iceServers || [{ urls: 'stun:stun.l.google.com:19302' }],
      bundlePolicy: 'max-bundle',
    });

    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });

    pc.ontrack = (ev) => {
      if (ev.streams?.[0]) {
        videoEl.srcObject = ev.streams[0];
        const tryPlay = () => videoEl.play().catch(() => {});
        tryPlay();
        setTimeout(tryPlay, 150);
        setTimeout(tryPlay, 500);
        videoEl.dispatchEvent(new CustomEvent('wheptrack', { detail: ev.streams[0] }));
      }
    };

    const offer = await pc.createOffer({ offerToReceiveVideo: true, offerToReceiveAudio: true });
    await pc.setLocalDescription(offer);

    // Don't wait long for ICE gathering; prioritize <2s stream start.
    await new Promise((resolve) => {
      if (pc.iceGatheringState === 'complete') return resolve();
      const check = () => {
        if (pc.iceGatheringState === 'complete') {
          pc.removeEventListener('icegatheringstatechange', check);
          resolve();
        }
      };
      pc.addEventListener('icegatheringstatechange', check);
      setTimeout(() => {
        pc.removeEventListener('icegatheringstatechange', check);
        resolve();
      }, 250);
    });

    const controller = new AbortController();
    const fetchTimer = setTimeout(() => controller.abort(), options.fetchTimeoutMs || 6000);
    let res;
    try {
      res = await fetch(whepUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/sdp' },
        body: pc.localDescription.sdp,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(fetchTimer);
    }

    if (!res.ok) throw new Error(`WHEP failed (${res.status})`);

    const answerSdp = await res.text();
    await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });

    return {
      pc,
      close() {
        try {
          pc.close();
        } catch {
          /* ignore */
        }
        videoEl.srcObject = null;
      },
    };
  }

  function resolveLocalUrl(url) {
    if (!url) return url;
    try {
      const u = new URL(url, window.location.origin);
      if (u.origin === window.location.origin) return u.href;
      if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') {
        const board = document.body.dataset.boardIp;
        u.hostname = board || window.location.hostname;
      }
      return u.href;
    } catch {
      return url;
    }
  }

  global.WhepPlayer = { connectWhep, resolveLocalUrl };
})(window);
