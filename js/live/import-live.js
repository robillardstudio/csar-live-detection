// Parse a CSV exported by export-live.js into in-memory recording rows (file is not modified).

function splitCsvLine(line) {
  const cells = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      cells.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  cells.push(current);
  return cells;
}

function parseCsv(text) {
  const normalized = String(text ?? "")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
  if (!normalized) {
    return { headers: [], rows: [] };
  }
  const lines = normalized.split("\n").filter((line) => line.length > 0);
  if (!lines.length) {
    return { headers: [], rows: [] };
  }
  const headers = splitCsvLine(lines[0]).map((header) => header.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cells = splitCsvLine(lines[i]);
    const row = {};
    for (let c = 0; c < headers.length; c += 1) {
      row[headers[c]] = cells[c] ?? "";
    }
    rows.push(row);
  }
  return { headers, rows };
}

function emptyToNull(value) {
  if (value == null) {
    return null;
  }
  const trimmed = String(value).trim();
  return trimmed === "" ? null : trimmed;
}

function num(value) {
  const raw = emptyToNull(value);
  if (raw == null) {
    return null;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function int(value) {
  const n = num(value);
  return n == null ? null : Math.trunc(n);
}

function parseBox2d(value) {
  const raw = emptyToNull(value);
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function csvRowToRecord(csv) {
  const xmin = num(csv.bbox_xmin);
  const ymin = num(csv.bbox_ymin);
  const xmax = num(csv.bbox_xmax);
  const ymax = num(csv.bbox_ymax);
  const hasBox =
    xmin != null && ymin != null && xmax != null && ymax != null;
  const nx = num(csv.bbox_norm_xmin);
  const ny = num(csv.bbox_norm_ymin);
  const nX = num(csv.bbox_norm_xmax);
  const nY = num(csv.bbox_norm_ymax);
  const hasNorm =
    nx != null && ny != null && nX != null && nY != null;

  const source = emptyToNull(csv.source) ?? "ai";
  const action = emptyToNull(csv.action);
  return {
    timestamp: int(csv.timestamp) ?? Date.now(),
    lat: num(csv.lat),
    lon: num(csv.lon),
    gps_accuracy: num(csv.gps_accuracy),
    gps_timestamp: int(csv.gps_timestamp) ?? num(csv.gps_timestamp),
    gps_quality: emptyToNull(csv.gps_quality),
    heading: num(csv.heading),
    camera_heading: num(csv.camera_heading),
    object_bearing: num(csv.object_bearing),
    distance_m: num(csv.distance_m),
    distance_method: emptyToNull(csv.distance_method),
    est_lat: num(csv.est_lat),
    est_lon: num(csv.est_lon),
    heading_accuracy: num(csv.heading_accuracy),
    device_beta: num(csv.device_beta),
    device_gamma: num(csv.device_gamma),
    screen_angle: num(csv.screen_angle) ?? int(csv.screen_angle),
    screen_orientation_type: emptyToNull(csv.screen_orientation_type),
    model: emptyToNull(csv.model),
    dtype: emptyToNull(csv.dtype),
    device: emptyToNull(csv.device),
    label: emptyToNull(csv.label) ?? "",
    confidence: num(csv.confidence),
    rank: int(csv.rank),
    count_in_view: int(csv.count_in_view),
    bbox: hasBox ? { xmin, ymin, xmax, ymax } : null,
    bbox_norm: hasNorm
      ? { xmin: nx, ymin: ny, xmax: nX, ymax: nY }
      : null,
    box_2d: parseBox2d(csv.box_2d),
    frame_w: int(csv.frame_w),
    frame_h: int(csv.frame_h),
    inference_ms: num(csv.inference_ms),
    prompt: emptyToNull(csv.prompt),
    source,
    action,
    refers_to_label: emptyToNull(csv.refers_to_label),
    // Remapped after ids are assigned.
    _refers_to_row_raw: int(csv.refers_to_row),
    _csv_id: int(csv.id),
  };
}

/**
 * @returns {{ rows: object[], model: string|null, startTime: number, endTime: number } | null}
 */
export function parseExportedCsv(text) {
  const { headers, rows: csvRows } = parseCsv(text);
  if (!headers.includes("timestamp") || !headers.includes("label")) {
    return null;
  }
  if (!csvRows.length) {
    return null;
  }

  const rows = csvRows.map(csvRowToRecord);
  rows.sort(
    (a, b) =>
      (a.timestamp ?? 0) - (b.timestamp ?? 0) ||
      (a._csv_id ?? 0) - (b._csv_id ?? 0),
  );

  const times = rows.map((row) => row.timestamp).filter((t) => t != null);
  const startTime = times.length ? Math.min(...times) : Date.now();
  const endTime = times.length ? Math.max(...times) : startTime;
  const model =
    rows.find((row) => row.model)?.model ??
    rows[0]?.model ??
    null;

  return { rows, model, startTime, endTime };
}
