function hashSeed(str) {
  let h = 0;
  for (let i = 0; i < str.length; i += 1) {
    h = (h << 5) - h + str.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}

const SEVERITY_COLORS = {
  critical: '#dc2626',
  warning: '#d97706',
  success: '#059669',
  info: '#64748b',
};

function buildSnapshotSvg(event) {
  const accent = SEVERITY_COLORS[event.severity] || SEVERITY_COLORS.info;
  const conf = Math.round((event.confidence || 0) * 100);
  const label = String(event.eventType || event.title || 'Person detected').slice(0, 32);
  const time = String(event.timeLabel || '');

  const box = (Array.isArray(event.box) && event.box.length === 4)
    ? event.box
    : (Array.isArray(event.bbox) && event.bbox.length === 4 ? event.bbox : null);

  const outW = 320;
  const outH = 320;

  let cropX;
  let cropY;
  let cropW;
  let cropH;

  if (box) {
    const frameW = 640;
    const frameH = 360;
    const bx1 = box[0] * frameW;
    const by1 = box[1] * frameH;
    const bx2 = box[2] * frameW;
    const by2 = box[3] * frameH;
    const padX = (bx2 - bx1) * 0.2;
    const padY = (by2 - by1) * 0.2;
    cropX = Math.max(0, bx1 - padX);
    cropY = Math.max(0, by1 - padY);
    cropW = Math.min(frameW - cropX, (bx2 - bx1) + padX * 2);
    cropH = Math.min(frameH - cropY, (by2 - by1) + padY * 2);
  } else {
    cropX = 0;
    cropY = 0;
    cropW = 640;
    cropH = 360;
  }

  const scaleX = outW / cropW;
  const scaleY = outH / cropH;
  const hasJpeg = Boolean(event.snapshotJpeg);

  if (hasJpeg) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${outW}" height="${outH}" viewBox="0 0 ${outW} ${outH}" role="img" aria-label="Detection snapshot: ${escapeXml(label)}">
  <defs>
    <clipPath id="crop">
      <rect x="0" y="0" width="${outW}" height="${outH}"/>
    </clipPath>
  </defs>
  <rect width="${outW}" height="${outH}" fill="#0f172a"/>
  <image
    href="data:image/jpeg;base64,${escapeXml(event.snapshotJpeg)}"
    x="${-cropX * scaleX}"
    y="${-cropY * scaleY}"
    width="${640 * scaleX}"
    height="${360 * scaleY}"
    clip-path="url(#crop)"
    preserveAspectRatio="none"
  />
  <rect x="0" y="${outH - 28}" width="${outW}" height="28" fill="rgba(0,0,0,0.65)"/>
  <text x="8" y="${outH - 10}" fill="#ffffff" font-family="Inter, Arial, sans-serif" font-size="11" font-weight="600">${escapeXml(label)} ${conf}%</text>
  <text x="${outW - 8}" y="${outH - 10}" fill="#94a3b8" font-family="Inter, Arial, sans-serif" font-size="10" text-anchor="end">${escapeXml(time)}</text>
  <circle cx="${outW - 10}" cy="10" r="4" fill="#ef4444">
    <animate attributeName="opacity" values="1;0.35;1" dur="1.8s" repeatCount="indefinite"/>
  </circle>
</svg>`;
  }

  const seed = hashSeed(event.id || event.title || 'event');
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${outW}" height="${outH}" viewBox="0 0 ${outW} ${outH}" role="img" aria-label="Detection snapshot: ${escapeXml(label)}">
  <defs>
    <linearGradient id="bg${seed}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#1e293b"/>
      <stop offset="100%" stop-color="#0f172a"/>
    </linearGradient>
  </defs>
  <rect width="${outW}" height="${outH}" fill="url(#bg${seed})"/>
  ${box ? `
  <rect x="60" y="60" width="${outW - 120}" height="${outH - 120}" fill="none" stroke="${accent}" stroke-width="2" stroke-dasharray="6 3" rx="4" opacity="0.5"/>
  <text x="${outW / 2}" y="${outH / 2 - 8}" fill="#94a3b8" font-family="Inter, Arial, sans-serif" font-size="11" text-anchor="middle">Snapshot unavailable</text>
  <text x="${outW / 2}" y="${outH / 2 + 10}" fill="#64748b" font-family="Inter, Arial, sans-serif" font-size="10" text-anchor="middle">Person detected at ${conf}%</text>
  ` : `
  <text x="${outW / 2}" y="${outH / 2}" fill="#64748b" font-family="Inter, Arial, sans-serif" font-size="11" text-anchor="middle">No snapshot available</text>
  `}
  <rect x="0" y="${outH - 28}" width="${outW}" height="28" fill="rgba(0,0,0,0.5)"/>
  <text x="8" y="${outH - 10}" fill="#ffffff" font-family="Inter, Arial, sans-serif" font-size="11" font-weight="600">${escapeXml(label)} ${conf}%</text>
  <text x="${outW - 8}" y="${outH - 10}" fill="#94a3b8" font-family="Inter, Arial, sans-serif" font-size="10" text-anchor="end">${escapeXml(time)}</text>
  <circle cx="${outW - 10}" cy="10" r="4" fill="#ef4444">
    <animate attributeName="opacity" values="1;0.35;1" dur="1.8s" repeatCount="indefinite"/>
  </circle>
</svg>`;
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = {
  buildSnapshotSvg,
};
