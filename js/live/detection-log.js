// In-memory log: one row per detected object while recording is on. export-live.js reads this.

const log = [];
// One entry per Start Recording → Stop Recording, numbered from 1 until the log is cleared.
const recordings = [];
let activeRecording = null;
const exportedIds = new Set();
let sessionStart = null;
let nextRowId = 1;
const clearListeners = new Set();
const updateListeners = new Set();
const logListeners = new Set();

const NEARBY_RADIUS_M = 5;
const NEARBY_ACCURACY_LIMIT_M = 15;
const NEARBY_FALLBACK_MS = 30_000;

function notifyLogListeners() {
  for (const listener of logListeners) {
    listener();
  }
}

export function onLiveDetectionLogUpdated(listener) {
  logListeners.add(listener);
  return () => logListeners.delete(listener);
}

function toRad(degrees) {
  return (degrees * Math.PI) / 180;
}

export function haversineMeters(a, b) {
  const R = 6371000;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function isAiRow(row) {
  return (row?.source ?? "ai") !== "user";
}

export function isUserAnnotationRow(row) {
  return row?.source === "user";
}

export function isSuppressingAction(row) {
  return (
    isUserAnnotationRow(row) &&
    (row.action === "delete" || row.action === "replace")
  );
}

// Latest delete/replace for a label near a point (within 5 m). Does not mutate AI rows.
export function getLabelSuppressionAt(label, lat, lon, rows = log) {
  if (!label || lat == null || lon == null) {
    return null;
  }
  let latest = null;
  for (const row of rows) {
    if (!isSuppressingAction(row)) {
      continue;
    }
    if ((row.refers_to_label || "").trim() !== label) {
      continue;
    }
    if (row.lat == null || row.lon == null) {
      continue;
    }
    if (
      haversineMeters(
        { lat, lon },
        { lat: Number(row.lat), lon: Number(row.lon) },
      ) > NEARBY_RADIUS_M
    ) {
      continue;
    }
    if (!latest || Number(row.timestamp) >= Number(latest.timestamp)) {
      latest = row;
    }
  }
  return latest;
}

function suppressedLabelsNear(gpsFix, now, rows = log) {
  const suppressed = new Set();
  const accuracy = gpsFix?.accuracy;
  const useSpatial =
    gpsFix?.lat != null &&
    gpsFix?.lon != null &&
    (accuracy == null || accuracy <= NEARBY_ACCURACY_LIMIT_M);

  for (const row of rows) {
    if (!isSuppressingAction(row)) {
      continue;
    }
    const label = (row.refers_to_label || "").trim();
    if (!label) {
      continue;
    }
    if (useSpatial) {
      if (
        row.lat == null ||
        row.lon == null ||
        haversineMeters(gpsFix, { lat: row.lat, lon: row.lon }) >
          NEARBY_RADIUS_M
      ) {
        continue;
      }
    } else if (now - Number(row.timestamp) > NEARBY_FALLBACK_MS) {
      continue;
    }
    suppressed.add(label);
  }
  return suppressed;
}

const NEARBY_MAX_LABELS = 8;

// Live stable buffer + logged AI rows within 5 m when GPS accuracy ≤ 15 m.
// Delete/replace actions hide that label here without editing original AI rows.
export function getNearbyAiLabels(
  gpsFix,
  { liveStable = [], now = Date.now() } = {},
) {
  const suppressed = suppressedLabelsNear(gpsFix, now);
  const byLabel = new Map();

  for (const item of liveStable) {
    const label = typeof item?.label === "string" ? item.label.trim() : "";
    if (!label || suppressed.has(label)) {
      continue;
    }
    byLabel.set(label, {
      label,
      count: item.count ?? 1,
      lastTimestamp: Number(item.lastTimestamp) || now,
      refersToRow: item.refersToRow ?? null,
    });
  }

  const accuracy = gpsFix?.accuracy;
  const useLogged =
    gpsFix?.lat != null &&
    gpsFix?.lon != null &&
    accuracy != null &&
    accuracy <= NEARBY_ACCURACY_LIMIT_M;

  if (useLogged) {
    for (const row of log) {
      if (!isAiRow(row) || typeof row.label !== "string" || !row.label.trim()) {
        continue;
      }
      if (row.lat == null || row.lon == null) {
        continue;
      }
      if (
        haversineMeters(gpsFix, { lat: row.lat, lon: row.lon }) > NEARBY_RADIUS_M
      ) {
        continue;
      }
      const label = row.label.trim();
      if (suppressed.has(label)) {
        continue;
      }
      const existing = byLabel.get(label);
      const ts = Number(row.timestamp);
      if (!existing) {
        byLabel.set(label, {
          label,
          count: 1,
          lastTimestamp: ts,
          refersToRow: row.id ?? row.timestamp,
        });
        continue;
      }
      existing.count += 1;
      if (ts >= existing.lastTimestamp) {
        existing.lastTimestamp = ts;
        existing.refersToRow = row.id ?? row.timestamp;
      }
    }
  }

  return [...byLabel.values()]
    .sort(
      (a, b) =>
        b.lastTimestamp - a.lastTimestamp || a.label.localeCompare(b.label),
    )
    .slice(0, NEARBY_MAX_LABELS);
}

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

export function getRecordingById(recordingId) {
  return recordings.find((item) => item.recording_id === recordingId) ?? null;
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
    transcript: null,
    transcript_status: null,
    transcript_error: null,
    ai_description: null,
    description_status: null,
    description_error: null,
    description_model: null,
    description_prompt: null,
    description_timestamp: null,
    analysis: null,
    analysis_status: null,
    analysis_error: null,
    analysis_timestamp: null,
    annotation_status: null,
  };
  recordings.push(activeRecording);
  return activeRecording;
}

export function onRecordingUpdated(listener) {
  updateListeners.add(listener);
  return () => updateListeners.delete(listener);
}

export function patchRecordingAnnotation(recordingId, patch) {
  const recording = getRecordingById(recordingId);
  if (!recording) {
    return null;
  }
  Object.assign(recording, patch);
  for (const listener of updateListeners) {
    listener(recording);
  }
  return recording;
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
    sum += haversineMeters(a, b);
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
  nextRowId = 1;
  for (const listener of clearListeners) {
    listener();
  }
  notifyLogListeners();
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
      id: nextRowId++,
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
      source: "ai",
      action: null,
      user_annotation: null,
      refers_to_label: null,
      refers_to_row: null,
      nearby_ai_labels: null,
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

  if (detections.length > 0) {
    notifyLogListeners();
  }
  return log.length;
}

export function logUserAnnotation({
  text = null,
  action = "add",
  gpsFix,
  orientation,
  refersToLabel = null,
  refersToRow = null,
  nearbyAiLabels = [],
}) {
  const resolvedAction = action || "add";
  const trimmed = String(text ?? "").trim();
  if (resolvedAction !== "delete" && !trimmed) {
    return null;
  }
  if (
    (resolvedAction === "delete" || resolvedAction === "replace") &&
    !refersToLabel
  ) {
    return null;
  }
  const timestamp = Date.now();
  sessionStart ??= timestamp;
  if (activeRecording) {
    activeRecording.row_count += 1;
    exportedIds.delete(activeRecording.recording_id);
  }
  const uniqueNearby = [...new Set(nearbyAiLabels.filter(Boolean))];
  const displayLabel =
    resolvedAction === "delete"
      ? refersToLabel
      : trimmed;
  const row = {
    id: nextRowId++,
    timestamp,
    recording_id: activeRecording?.recording_id ?? null,
    lat: gpsFix?.lat ?? null,
    lon: gpsFix?.lon ?? null,
    gps_accuracy: gpsFix?.accuracy ?? null,
    gps_timestamp: gpsFix?.timestamp ?? null,
    heading: orientation?.heading ?? orientation?.cameraHeading ?? null,
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
    model: null,
    dtype: null,
    device: null,
    label: displayLabel,
    confidence: null,
    rank: null,
    source: "user",
    action: resolvedAction,
    user_annotation: resolvedAction === "delete" ? null : trimmed,
    refers_to_label: refersToLabel || null,
    refers_to_row: refersToRow ?? null,
    nearby_ai_labels: uniqueNearby,
    bbox: null,
    bbox_norm: null,
    frame_w: null,
    frame_h: null,
    inference_ms: null,
  };
  log.push(row);
  notifyLogListeners();
  return row;
}
