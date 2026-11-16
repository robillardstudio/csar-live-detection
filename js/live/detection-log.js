// In-memory log: one row per detected object while recording is on. export-live.js reads this.

const log = [];
// One entry per Start Recording → Stop Recording, numbered from 1 until the log is cleared.
const recordings = [];
let activeRecording = null;
const exportedIds = new Set();
let sessionStart = null;
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

export function getRecordings() {
  return recordings;
}

// null means all recordings.
export function getRecordingRows(recordingId) {
  return recordingId == null
    ? log.slice()
    : log.filter((row) => row.recording_id === recordingId);
}

export function recordingDurationMs(recording, now = Date.now()) {
  return (recording.end_time ?? now) - recording.start_time;
}

export function startRecording(modelId, { startGps = null } = {}) {
  activeRecording = {
    recording_id: recordings.length + 1,
    start_time: Date.now(),
    end_time: null,
    model: modelId,
    row_count: 0,
    audio_blob: null,
    audio_mime: null,
    duration_ms: null,
    frames: [],
    track: [],
    start_gps: startGps,
    end_gps: null,
  };
  recordings.push(activeRecording);
  return activeRecording;
}

export function addRecordingFrame(frame) {
  if (activeRecording) {
    activeRecording.frames.push(frame);
  }
}

export function addTrackPoint(point) {
  if (activeRecording) {
    activeRecording.track.push(point);
  }
}

// Great-circle length of a recording track in meters.
export function trackDistanceMeters(track) {
  if (!track?.length) {
    return 0;
  }
  const toRad = (degrees) => (degrees * Math.PI) / 180;
  const R = 6371000;
  let sum = 0;
  for (let i = 1; i < track.length; i += 1) {
    const a = track[i - 1];
    const b = track[i];
    if (
      a?.lat == null ||
      a?.lon == null ||
      b?.lat == null ||
      b?.lon == null
    ) {
      continue;
    }
    const dLat = toRad(b.lat - a.lat);
    const dLon = toRad(b.lon - a.lon);
    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);
    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    sum += 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  return sum;
}

// Ends the active recording and attaches audio / end GPS when provided.
export function stopRecording({ audio_blob = null, audio_mime = null, end_gps = null } = {}) {
  if (!activeRecording) {
    return null;
  }
  activeRecording.end_time = Date.now();
  activeRecording.duration_ms =
    activeRecording.end_time - activeRecording.start_time;
  activeRecording.audio_blob = audio_blob;
  activeRecording.audio_mime = audio_mime;
  activeRecording.end_gps = end_gps;
  const done = activeRecording;
  activeRecording = null;
  return done;
}

// A recording counts as exported once an export included it; rows logged after that undo it.
export function markRecordingsExported(recordingId) {
  for (const recording of recordings) {
    if (recordingId == null || recording.recording_id === recordingId) {
      exportedIds.add(recording.recording_id);
    }
  }
}

function recordingHasExportableData(recording) {
  return (
    recording.row_count > 0 ||
    (recording.frames?.length ?? 0) > 0 ||
    (recording.track?.length ?? 0) > 0 ||
    Boolean(recording.audio_blob) ||
    recording.end_time != null
  );
}

export function getUnexportedRecordingCount() {
  return recordings.filter(
    (recording) =>
      recordingHasExportableData(recording) &&
      !exportedIds.has(recording.recording_id),
  ).length;
}

// Views that show a copy of the log use this to reset when it is cleared.
export function onLiveDetectionLogCleared(listener) {
  clearListeners.add(listener);
}

export function clearLiveDetectionLog() {
  log.length = 0;
  recordings.length = 0;
  activeRecording = null;
  exportedIds.clear();
  sessionStart = null;
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
    sessionStart ??= timestamp;
    if (activeRecording) {
      activeRecording.row_count += detections.length;
      exportedIds.delete(activeRecording.recording_id);
    }
  }
  for (const detection of detections) {
    const hasBox = detection.box != null;
    log.push({
      timestamp,
      recording_id: activeRecording?.recording_id ?? null,
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
