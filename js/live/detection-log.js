// In-memory log: one row per detected object while recording is on. export-live.js reads this.

const log = [];
let sessionStart = null;
let exported = false;
const clearListeners = new Set();

export function getLiveDetectionSessionStart() {
  return sessionStart;
}

export function getLiveDetectionLog() {
  return log;
}

export function getLiveDetectionLogCount() {
  return log.length;
}

export function isLiveDetectionLogExported() {
  return exported;
}

// Covers the rows logged so far; the next logged row clears it.
export function markLiveDetectionLogExported() {
  exported = log.length > 0;
}

// Views that show a copy of the log use this to reset when it is cleared.
export function onLiveDetectionLogCleared(listener) {
  clearListeners.add(listener);
}

export function clearLiveDetectionLog() {
  log.length = 0;
  sessionStart = null;
  exported = false;
  for (const listener of clearListeners) {
    listener();
  }
}

// Pixel bbox matches the inference frame; bbox_norm (0–1) is resolution-independent for the later AR/3D stage.
function normalizeBbox(box, frameW, frameH) {
  return {
    xmin: box.xmin / frameW,
    ymin: box.ymin / frameH,
    xmax: box.xmax / frameW,
    ymax: box.ymax / frameH,
  };
}

export function logDetectionFrame({
  detections,
  frameW,
  frameH,
  inferenceMs,
  timestamp,
  gpsFix,
  orientation,
  backend,
  modelId,
}) {
  if (detections.length > 0) {
    exported = false;
    sessionStart ??= timestamp;
  }
  for (const detection of detections) {
    const hasBox = detection.box != null;
    log.push({
      timestamp,
      lat: gpsFix?.lat ?? null,
      lon: gpsFix?.lon ?? null,
      gps_accuracy: gpsFix?.accuracy ?? null,
      gps_timestamp: gpsFix?.timestamp ?? null,
      heading: orientation?.heading ?? null,
      camera_heading: orientation?.cameraHeading ?? null,
      object_bearing: detection.bearing ?? null,
      distance_m: detection.distance ?? null,
      distance_method: detection.distanceMethod ?? null,
      est_lat: detection.estLat ?? null,
      est_lon: detection.estLon ?? null,
      heading_accuracy: orientation?.accuracy ?? null,
      device_beta: orientation?.beta ?? null,
      device_gamma: orientation?.gamma ?? null,
      screen_angle: orientation?.screenAngle ?? null,
      screen_orientation_type: orientation?.screenOrientationType ?? null,
      model: modelId,
      dtype: backend.dtype,
      device: backend.device,
      label: detection.label,
      confidence: detection.score,
      rank: detection.rank ?? null,
      bbox: hasBox
        ? {
            xmin: detection.box.xmin,
            ymin: detection.box.ymin,
            xmax: detection.box.xmax,
            ymax: detection.box.ymax,
          }
        : null,
      bbox_norm: hasBox
        ? normalizeBbox(detection.box, frameW, frameH)
        : null,
      frame_w: frameW,
      frame_h: frameH,
      inference_ms: inferenceMs,
    });
  }

  return log.length;
}
