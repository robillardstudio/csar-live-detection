// In-memory log: one row per detected object while recording is on. export-live.js reads this.

const log = [];
// One entry per Start Recording → Stop Recording, numbered from 1 until the log is cleared.
const recordings = [];
let activeRecording = null;
const exportedIds = new Set();
let sessionStart = null;
let nextRowId = 1;
const clearListeners = new Set();
const changeListeners = new Set();

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

export function getActiveRecordingId() {
  return activeRecording?.recording_id ?? null;
}

/** True if this label already has a log/CSV row in the active recording. */
export function isLabelLoggedInActiveRecording(label) {
  const recordingId = activeRecording?.recording_id;
  const needle = String(label ?? "").trim();
  if (recordingId == null || !needle) {
    return false;
  }
  return log.some(
    (row) =>
      row.recording_id === recordingId &&
      String(row.label ?? "").trim() === needle,
  );
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

// Fires after co-annotation rows are appended so Review can refresh without clearing.
export function onLiveDetectionLogChanged(listener) {
  changeListeners.add(listener);
}

function notifyLogChanged() {
  for (const listener of changeListeners) {
    listener();
  }
}

export function clearLiveDetectionLog() {
  log.length = 0;
  recordings.length = 0;
  activeRecording = null;
  exportedIds.clear();
  sessionStart = null;
  nextRowId = 1;
  for (const listener of clearListeners) {
    listener();
  }
}

function bumpRecordingRowCount(recordingId) {
  const recording =
    activeRecording?.recording_id === recordingId
      ? activeRecording
      : recordings.find((item) => item.recording_id === recordingId);
  if (recording) {
    recording.row_count += 1;
    exportedIds.delete(recording.recording_id);
  }
}

function appendUserRow(row) {
  log.push(row);
  if (row.recording_id != null) {
    bumpRecordingRowCount(row.recording_id);
  }
  notifyLogChanged();
  return row;
}

// Live co-annotation at the current GPS/time. Never edits or deletes AI rows.
export function logUserAction({
  action,
  label = "",
  refersToLabel = null,
  refersToRow = null,
  timestamp = Date.now(),
  gpsFix = null,
  orientation = null,
  modelId = null,
  backend = null,
  box = null,
  box2d = null,
  frameW = null,
  frameH = null,
  prompt = null,
  gpsQuality = null,
}) {
  if (action !== "add" && action !== "replace" && action !== "delete") {
    return null;
  }
  const trimmed = String(label ?? "").trim();
  if (action !== "delete" && !trimmed) {
    return null;
  }

  const hasBox = box != null;
  sessionStart ??= timestamp;
  return appendUserRow({
    id: nextRowId++,
    timestamp,
    recording_id: activeRecording?.recording_id ?? null,
    lat: gpsFix?.lat ?? null,
    lon: gpsFix?.lon ?? null,
    gps_accuracy: gpsFix?.accuracy ?? null,
    gps_timestamp: gpsFix?.timestamp ?? null,
    gps_quality: gpsQuality ?? null,
    heading: orientation?.heading ?? null,
    camera_heading: orientation?.cameraHeading ?? null,
    object_bearing: null,
    distance_m: null,
    distance_method: null,
    est_lat: null,
    est_lon: null,
    heading_accuracy: orientation?.accuracy ?? null,
    device_beta: orientation?.beta ?? null,
    device_gamma: orientation?.gamma ?? null,
    screen_angle: orientation?.screenAngle ?? null,
    screen_orientation_type: orientation?.screenOrientationType ?? null,
    model: modelId,
    dtype: backend?.dtype ?? null,
    device: backend?.device ?? null,
    label: action === "delete" ? "" : trimmed,
    confidence: null,
    rank: null,
    bbox: hasBox
      ? {
          xmin: box.xmin,
          ymin: box.ymin,
          xmax: box.xmax,
          ymax: box.ymax,
        }
      : null,
    bbox_norm:
      hasBox && frameW && frameH ? normalizeBbox(box, frameW, frameH) : null,
    box_2d: Array.isArray(box2d) ? box2d : null,
    frame_w: frameW,
    frame_h: frameH,
    inference_ms: null,
    prompt: prompt ?? null,
    source: "user",
    action,
    refers_to_label: refersToLabel,
    refers_to_row: refersToRow,
  });
}

// Review-map replace: same lat/lon/time as the AI row. Never edits that row.
export function logLabelReplace(originalRow, newLabel) {
  const label = String(newLabel ?? "").trim();
  if (!originalRow || !label || originalRow.source === "user") {
    return null;
  }

  sessionStart ??= originalRow.timestamp;
  return appendUserRow({
    ...originalRow,
    id: nextRowId++,
    source: "user",
    action: "replace",
    label,
    refers_to_label: originalRow.label,
    refers_to_row: originalRow.id,
  });
}

// Undo for a live delete toast: removes a user action row only.
export function removeUserLogRow(rowId) {
  const index = log.findIndex(
    (row) => row.id === rowId && row.source === "user",
  );
  if (index < 0) {
    return false;
  }
  const [removed] = log.splice(index, 1);
  if (removed.recording_id != null) {
    const recording = recordings.find(
      (item) => item.recording_id === removed.recording_id,
    );
    if (recording && recording.row_count > 0) {
      recording.row_count -= 1;
    }
  }
  notifyLogChanged();
  return true;
}

export function findLatestAiRowForLabel(label) {
  const needle = String(label ?? "").trim();
  if (!needle) {
    return null;
  }
  for (let i = log.length - 1; i >= 0; i -= 1) {
    const row = log[i];
    if (row.source !== "user" && row.label === needle) {
      return row;
    }
  }
  return null;
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
  prompt = null,
  forceLog = false,
  gpsQuality = null,
}) {
  if (detections.length > 0) {
    sessionStart ??= timestamp;
    if (activeRecording || forceLog) {
      if (activeRecording) {
        activeRecording.row_count += detections.length;
        exportedIds.delete(activeRecording.recording_id);
      }
    }
  }
  const logged = [];
  for (const detection of detections) {
    const hasBox = detection.box != null;
    const id = nextRowId;
    nextRowId += 1;
    log.push({
      id,
      timestamp,
      recording_id: activeRecording?.recording_id ?? null,
      lat: gpsFix?.lat ?? null,
      lon: gpsFix?.lon ?? null,
      gps_accuracy: gpsFix?.accuracy ?? null,
      gps_timestamp: gpsFix?.timestamp ?? null,
      gps_quality: gpsQuality ?? null,
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
      dtype: backend?.dtype ?? null,
      device: backend?.device ?? null,
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
      box_2d: Array.isArray(detection.box2d) ? detection.box2d : null,
      frame_w: frameW,
      frame_h: frameH,
      inference_ms: inferenceMs,
      prompt: prompt ?? detection.prompt ?? null,
      source: "ai",
      action: null,
      refers_to_label: null,
      refers_to_row: null,
    });
    logged.push({ id, label: detection.label });
  }

  return logged;
}
