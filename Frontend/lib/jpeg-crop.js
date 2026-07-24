/**
 * Crop a base64 JPEG to a normalized xyxy bbox (tight person/face event photos).
 * Clean crop only — no bbox overlay drawn on the event photo.
 */

function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function normalizeXyxy(box) {
  if (!Array.isArray(box) || box.length < 4) return null;
  const nums = box.map(Number);
  if (!nums.every((v) => Number.isFinite(v))) return null;
  let [x1, y1, x2, y2] = nums;
  if (x2 < x1) [x1, x2] = [x2, x1];
  if (y2 < y1) [y1, y2] = [y2, y1];
  if (x2 <= x1 || y2 <= y1) return null;
  if (nums.every((v) => v >= -0.05 && v <= 1.05)) {
    return [clamp01(x1), clamp01(y1), clamp01(x2), clamp01(y2)];
  }
  return null;
}

/**
 * @param {string} jpegBase64
 * @param {number[]} box normalized xyxy
 * @param {{ pad?: number, drawBox?: boolean, quality?: number, minLongSide?: number }} [opts]
 * @returns {Promise<string|null>} cropped jpeg base64 (no data: prefix)
 */
async function cropJpegToBbox(jpegBase64, box, opts = {}) {
  const norm = normalizeXyxy(box);
  if (!jpegBase64 || typeof jpegBase64 !== 'string' || jpegBase64.length < 64 || !norm) {
    return null;
  }

  let sharp;
  try {
    sharp = require('sharp');
  } catch {
    return null;
  }

  const pad = Number.isFinite(opts.pad) ? opts.pad : 0.06;
  const drawBox = opts.drawBox === true;
  const quality = opts.quality || 95;
  const minLongSide = opts.minLongSide || 640;

  try {
    const input = Buffer.from(jpegBase64.replace(/^data:image\/\w+;base64,/, ''), 'base64');
    const meta = await sharp(input, { failOn: 'none' }).metadata();
    const W = meta.width || 0;
    const H = meta.height || 0;
    if (W < 8 || H < 8) return null;

    const [nx1, ny1, nx2, ny2] = norm;
    const bw = (nx2 - nx1) * W;
    const bh = (ny2 - ny1) * H;
    let left = Math.floor(nx1 * W - bw * pad);
    let top = Math.floor(ny1 * H - bh * pad);
    let right = Math.ceil(nx2 * W + bw * pad);
    let bottom = Math.ceil(ny2 * H + bh * pad);

    left = Math.max(0, left);
    top = Math.max(0, top);
    right = Math.min(W, right);
    bottom = Math.min(H, bottom);

    let width = Math.max(1, right - left);
    let height = Math.max(1, bottom - top);

    if (width < 24) {
      const mid = Math.round((left + right) / 2);
      left = Math.max(0, mid - 12);
      right = Math.min(W, left + 24);
      width = right - left;
    }
    if (height < 24) {
      const mid = Math.round((top + bottom) / 2);
      top = Math.max(0, mid - 12);
      bottom = Math.min(H, top + 24);
      height = bottom - top;
    }

    let pipeline = sharp(input, { failOn: 'none' })
      .extract({ left, top, width, height })
      .rotate(); // honor EXIF if present

    // Upscale small crops so the event photo looks clearer in the lightbox.
    const longSide = Math.max(width, height);
    if (longSide < minLongSide) {
      const scale = minLongSide / longSide;
      pipeline = pipeline.resize({
        width: Math.round(width * scale),
        height: Math.round(height * scale),
        fit: 'fill',
        kernel: 'lanczos3',
      });
    }

    // Mild sharpen — helps CCTV JPEG look a bit clearer without looking fake.
    pipeline = pipeline.sharpen({ sigma: 0.7, m1: 0.6, m2: 0.3 });

    if (drawBox) {
      const outW = longSide < minLongSide ? Math.round(width * (minLongSide / longSide)) : width;
      const outH = longSide < minLongSide ? Math.round(height * (minLongSide / longSide)) : height;
      const sx = outW / width;
      const sy = outH / height;
      const bx1 = Math.max(0, Math.round((nx1 * W - left) * sx));
      const by1 = Math.max(0, Math.round((ny1 * H - top) * sy));
      const bx2 = Math.min(outW - 1, Math.round((nx2 * W - left) * sx));
      const by2 = Math.min(outH - 1, Math.round((ny2 * H - top) * sy));
      const rw = Math.max(1, bx2 - bx1);
      const rh = Math.max(1, by2 - by1);
      const stroke = Math.max(2, Math.round(Math.min(outW, outH) * 0.012));
      const boxColor = opts.boxColor || '#22c55e';
      const svg = Buffer.from(
        `<svg width="${outW}" height="${outH}" xmlns="http://www.w3.org/2000/svg">`
        + `<rect x="${bx1}" y="${by1}" width="${rw}" height="${rh}" `
        + `fill="none" stroke="${boxColor}" stroke-width="${stroke}"/>`
        + `</svg>`,
      );
      pipeline = pipeline.composite([{ input: svg, top: 0, left: 0 }]);
    }

    const out = await pipeline
      .jpeg({ quality, mozjpeg: true, chromaSubsampling: '4:4:4' })
      .toBuffer();
    if (!out?.length) return null;
    return out.toString('base64');
  } catch (err) {
    console.warn('[jpeg-crop]', err.message);
    return null;
  }
}

module.exports = {
  cropJpegToBbox,
  normalizeXyxy,
};
