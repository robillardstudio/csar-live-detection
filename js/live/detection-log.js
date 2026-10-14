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

export function startRecording(modelId) {
  activeRecording = {
    recording_id: recordings.length + 1,
    start_time: Date.now(),
    end_time: null,
    model: modelId,
    row_count: 0,
  };
  recordings.push(activeRecording);
}

export function stopRecording() {
  if (activeRecording) {
    activeRecording.end_time = Date.now();
    activeRecording = null;
  }
}

// A recording counts as exported once an export included it; rows logged after that undo it.
export function markRecordingsExported(recordingId) {
  for (const recording of recordings) {
    if (recordingId == null || recording.recording_id === recordingId) {
      exportedIds.add(recording.recording_id);
    }
  }
}

export function getUnexportedRecordingCount() {
  return recordings.filter(
    (recording) =>
      recording.row_count > 0 && !exportedIds.has(recording.recording_id),
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
