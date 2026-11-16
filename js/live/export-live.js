// Turns the in-memory detection log into a CSV or JSON download (via export.js).
import { downloadFile } from "../utils/export.js";
import {
  getLiveDetectionSessionStart,
  getRecordingRows,
  getRecordings,
} from "./detection-log.js";

const CSV_HEADERS = [
  "timestamp",
  "recording_id",
  "lat",
  "lon",
  "gps_accuracy",
  "gps_timestamp",
  "heading",
  "camera_heading",
  "object_bearing",
  "distance_m",
  "distance_method",
  "est_lat",
  "est_lon",
  "heading_accuracy",
  "device_beta",
  "device_gamma",
  "screen_angle",
  "screen_orientation_type",
  "model",
  "dtype",
  "device",
  "label",
  "confidence",
  "rank",
  "bbox_xmin",
  "bbox_ymin",
  "bbox_xmax",
  "bbox_ymax",
  "bbox_norm_xmin",
  "bbox_norm_ymin",
  "bbox_norm_xmax",
  "bbox_norm_ymax",
  "frame_w",
  "frame_h",
  "inference_ms",
  "transcript",
  "ai_description",
  "description_model",
  "description_prompt",
];

function recordingAnnotationFields(recordingId) {
  const recording = getRecordings().find(
    (item) => item.recording_id === recordingId,
  );
  return {
    transcript: recording?.transcript ?? "",
    ai_description: recording?.ai_description ?? "",
    description_model: recording?.description_model ?? "",
    description_prompt: recording?.description_prompt ?? "",
  };
}

function formatTimestampStamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

function quoteCsvLabel(label) {
  return `"${String(label ?? "").replace(/"/g, '""')}"`;
}

function formatNullableNumber(value, digits) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return "";
  }
  return Number(value).toFixed(digits);
}

function rowToCsvLine(row) {
  const annotation = recordingAnnotationFields(row.recording_id);
  return [
    row.timestamp,
    row.recording_id ?? "",
    formatNullableNumber(row.lat, 8),
    formatNullableNumber(row.lon, 8),
    row.gps_accuracy ?? "",
    row.gps_timestamp ?? "",
    formatNullableNumber(row.heading, 2),
    formatNullableNumber(row.camera_heading, 2),
    formatNullableNumber(row.object_bearing, 2),
    formatNullableNumber(row.distance_m, 2),
    row.distance_method ?? "",
    formatNullableNumber(row.est_lat, 8),
    formatNullableNumber(row.est_lon, 8),
    row.heading_accuracy ?? "",
    formatNullableNumber(row.device_beta, 2),
    formatNullableNumber(row.device_gamma, 2),
    row.screen_angle ?? "",
    row.screen_orientation_type ?? "",
    row.model,
    row.dtype,
    row.device,
    quoteCsvLabel(row.label),
    Number(row.confidence).toFixed(3),
    row.rank ?? "",
    row.bbox?.xmin ?? "",
    row.bbox?.ymin ?? "",
    row.bbox?.xmax ?? "",
    row.bbox?.ymax ?? "",
    row.bbox_norm?.xmin ?? "",
    row.bbox_norm?.ymin ?? "",
    row.bbox_norm?.xmax ?? "",
    row.bbox_norm?.ymax ?? "",
    row.frame_w,
    row.frame_h,
    row.inference_ms,
    quoteCsvLabel(annotation.transcript),
    quoteCsvLabel(annotation.ai_description),
    quoteCsvLabel(annotation.description_model),
    quoteCsvLabel(annotation.description_prompt),
  ].join(",");
}

function buildMetadata(rows, backendInfo) {
  return {
    exported_at: new Date().toISOString(),
    model: backendInfo.model ?? rows[0]?.model ?? null,
    dtype: backendInfo.dtype ?? rows[0]?.dtype ?? null,
    device: backendInfo.device ?? rows[0]?.device ?? null,
    row_count: rows.length,
    session_start: getLiveDetectionSessionStart(),
  };
}

// recordingId null exports all recordings.
function exportFilename(recordingId, extension) {
  const scope = recordingId == null ? "all" : `rec${recordingId}`;
  return `live-detection-${scope}-${formatTimestampStamp()}.${extension}`;
}

export function exportLiveDetectionCsv(backendInfo, recordingId) {
  const rows = getRecordingRows(recordingId);
  if (!rows.length) {
    return false;
  }

  const csv = [CSV_HEADERS.join(","), ...rows.map(rowToCsvLine)].join("\n");
  downloadFile(csv, exportFilename(recordingId, "csv"), "text/csv;charset=utf-8");
  return true;
}

function serializeRecording(item) {
  const {
    audio_blob,
    frames,
    transcript_error,
    description_error,
    analysis_error,
    ...rest
  } = item;
  return {
    ...rest,
    has_audio: Boolean(audio_blob),
    frame_count: frames?.length ?? 0,
    frames: (frames ?? []).map(({ jpeg, ...meta }) => meta),
    track: item.track ?? [],
    transcript: item.transcript ?? null,
    ai_description: item.ai_description ?? null,
    description_model: item.description_model ?? null,
    description_prompt: item.description_prompt ?? null,
    analysis: item.analysis ?? null,
    analysis_status: item.analysis_status ?? null,
  };
}

export function exportLiveDetectionJson(backendInfo, recordingId) {
  const rows = getRecordingRows(recordingId);
  const recordings = getRecordings()
    .filter((item) => recordingId == null || item.recording_id === recordingId)
    .map(serializeRecording);
  if (!rows.length && !recordings.length) {
    return false;
  }

  const payload = {
    ...buildMetadata(rows, backendInfo),
    recordings,
    rows,
  };
  downloadFile(
    JSON.stringify(payload, null, 2),
    exportFilename(recordingId, "json"),
    "application/json;charset=utf-8",
  );
  return true;
}
