// Tiny grayscale thumbnail compare for "device is still" skip logic.
const THUMB_W = 32;
const THUMB_H = 24;
const METERS_PER_DEG_LAT = 111320;

// Higher sensitivity → larger MAD allowed before the scene counts as changed (more skipping).
export const STILL_SENSITIVITY = {
  low: 12,
  medium: 20,
  high: 32,
};

export function createThumbnailBuffer() {
  return {
    canvas: document.createElement("canvas"),
    ctx: null,
    gray: new Uint8Array(THUMB_W * THUMB_H),
  };
}

export function grabGrayscaleThumbnail(sourceCanvas, buffer) {
  const { canvas } = buffer;
  if (canvas.width !== THUMB_W || canvas.height !== THUMB_H) {
    canvas.width = THUMB_W;
    canvas.height = THUMB_H;
  }
  buffer.ctx ??= canvas.getContext("2d", { willReadFrequently: true });
  const ctx = buffer.ctx;
  ctx.drawImage(sourceCanvas, 0, 0, THUMB_W, THUMB_H);
  const { data } = ctx.getImageData(0, 0, THUMB_W, THUMB_H);
  const gray = buffer.gray;
  for (let i = 0, j = 0; i < data.length; i += 4, j += 1) {
    gray[j] = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0;
  }
  return gray;
}

export function meanAbsDiff(a, b) {
  if (!a || !b || a.length !== b.length) {
    return Number.POSITIVE_INFINITY;
  }
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    sum += Math.abs(a[i] - b[i]);
  }
  return sum / a.length;
}

export function distanceMeters(a, b) {
  if (
    a?.lat == null ||
    a?.lon == null ||
    b?.lat == null ||
    b?.lon == null
  ) {
    return 0;
  }
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * METERS_PER_DEG_LAT * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function copyThumbnail(gray) {
  return Uint8Array.from(gray);
}
