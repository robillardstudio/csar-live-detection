// Turns the in-memory detection log into a CSV or JSON download (via export.js).
import { downloadFile } from "../utils/export.js";
import {
  getLiveDetectionLog,
  getLiveDetectionSessionStart,
} from "./detection-log.js";

const CSV_HEADERS = [
  "timestamp",
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
];

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

// Replace each row's coordinates with the track position at the row's own detection time,
// so detections between two fixes spread along the path instead of stacking on one fix.
function withInterpolatedPositions(rows, gps) {
  if (!gps) {
    return rows;
  }
  return rows.map((row) => {
    const pos = gps.positionAt(row.timestamp);
    return pos
      ? { ...row, lat: pos.lat, lon: pos.lon, gps_accuracy: pos.accuracy }
      : row;
  });
}

function rowToCsvLine(row) {
  return [
    row.timestamp,
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

export function exportLiveDetectionCsv(backendInfo, gps) {
  const rows = withInterpolatedPositions(getLiveDetectionLog(), gps);
  if (!rows.length) {
    return false;
  }

  const csv = [CSV_HEADERS.join(","), ...rows.map(rowToCsvLine)].join("\n");
  const filename = `live-detection_${formatTimestampStamp()}.csv`;
  downloadFile(csv, filename, "text/csv;charset=utf-8");
  return true;
}

export function exportLiveDetectionJson(backendInfo, gps) {
  const rows = withInterpolatedPositions(getLiveDetectionLog(), gps);
  if (!rows.length) {
    return false;
  }

  const payload = {
    ...buildMetadata(rows, backendInfo),
    rows,
  };
  const filename = `live-detection_${formatTimestampStamp()}.json`;
  downloadFile(
    JSON.stringify(payload, null, 2),
    filename,
    "application/json;charset=utf-8",
  );
  return true;
}

// Every raw fix, including rejected ones, so weak-signal stretches show up in the accuracy column.
export function exportGpsTrackCsv(backendInfo, gps) {
  const track = gps?.getTrack() ?? [];
  if (!track.length) {
    return false;
  }

  const csv = [
    "timestamp,lat,lon,accuracy",
    ...track.map(
      (f) =>
        `${f.timestamp},${formatNullableNumber(f.lat, 8)},${formatNullableNumber(f.lon, 8)},${f.accuracy ?? ""}`,
    ),
  ].join("\n");
  downloadFile(
    csv,
    `gps-track_${formatTimestampStamp()}.csv`,
    "text/csv;charset=utf-8",
  );
  return true;
}
