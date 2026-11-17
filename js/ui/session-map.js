// On-demand map of the walked GPS path and detections from the in-memory detection log. Read-only.
import {
  getLabelSuppressionAt,
  isAiRow,
  isUserAnnotationRow,
} from "../live/detection-log.js";
import { formatClockTime } from "../utils/time.js";

const LEAFLET_CSS =
  "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css";
const LEAFLET_JS =
  "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js";
const TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const SINGLE_POINT_ZOOM = 18;
const MAX_ZOOM = 19;
// Below this zoom, dots are too close together for readable labels.
const LABEL_MIN_ZOOM = 18;
const PHONE_QUERY = "(max-width: 640px)";
// One color per recording with "All recordings"; none match a label color. Paths past the palette are dashed.
const PATH_PALETTE = ["#2563eb", "#65a30d", "#4f46e5"];
const OVERLAYS = [
  ["path", "Walking path"],
  ["viewer", "Where I was"],
  ["objects", "Where objects were"],
  ["sightLines", "Sight lines"],
  ["labels", 'Labels <span class="map-layers__hint">(zoom in)</span>'],
  ["userAnnotations", "User annotations"],
];
const AI_MARKER_COLOR = "#16a34a";
const USER_MARKER_COLOR = "#ea580c";
// All label colors avoid the path blue and the start green / end red.
const FIXED_LABEL_COLORS = new Map([
  ["person", "#f59e0b"],
  ["bench", "#8b5cf6"],
  ["tree", "#a16207"],
  ["car", "#ec4899"],
  ["bicycle", "#06b6d4"],
  ["dog", "#d946ef"],
  ["potted plant", "#14b8a6"],
  ["traffic light", "#334155"],
]);
// Hash fallback for every other label. None of these repeat a fixed color.
const LABEL_PALETTE = [
  "#fde047",
  "#ca8a04",
  "#f97316",
  "#c2410c",
  "#fdba74",
  "#f9a8d4",
  "#9d174d",
  "#fb7185",
  "#c4b5fd",
  "#5b21b6",
  "#e879f9",
  "#86198f",
  "#67e8f9",
  "#0e7490",
  "#5eead4",
  "#115e59",
  "#78716c",
  "#94a3b8",
  "#1c1917",
  "#78350f",
];
const LEGEND_LIMIT = 8;
// 5 decimal places is ~1 m, finer than phone GPS accuracy.
const DEDUPE_DECIMALS = 5;
// Screen-space spread for dots that share a location; recomputed on zoom so it stays constant in pixels.
const FAN_MIN_RADIUS_PX = 16;
// Arc length reserved per fanned dot: dot diameter plus a small gap.
const FAN_SPACING_PX = 13;

// Kept for the page visit across tabs, recordings and mode switches; no storage.
const layerState = {
  base: "street",
  overlays: new Set(["path", "viewer", "userAnnotations"]),
  // "raw" = machine labels as recorded; "coannotated" = after delete/replace.
  labelView: "coannotated",
};

let map = null;
let layers = null;
let leafletLoader = null;
let openGeneration = 0;

function loadStylesheet(href) {
  if (document.querySelector(`link[href="${href}"]`)) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.onload = () => resolve();
    link.onerror = () => {
      link.remove();
      reject(new Error("Leaflet CSS failed to load"));
    };
    document.head.appendChild(link);
  });
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      script.remove();
      reject(new Error("Leaflet failed to load"));
    };
    document.head.appendChild(script);
  });
}

function loadLeaflet() {
  if (window.L?.map) {
    return Promise.resolve(window.L);
  }
  if (!leafletLoader) {
    leafletLoader = Promise.all([
      loadStylesheet(LEAFLET_CSS),
      loadScript(LEAFLET_JS),
    ])
      .then(() => window.L)
      .catch((error) => {
        leafletLoader = null;
        throw error;
      });
  }
  return leafletLoader;
}

function isValidCoordinate(lat, lon) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lon) <= 180
  );
}

function extractPath(rows) {
  const fixes = [];
  rows.forEach((row, index) => {
    if (row.lat == null || row.lon == null) {
      return;
    }
    const lat = Number(row.lat);
    const lon = Number(row.lon);
    if (!isValidCoordinate(lat, lon)) {
      return;
    }
    fixes.push({ lat, lon, timestamp: Number(row.timestamp), index });
  });

  fixes.sort(
    (a, b) =>
      (Number.isFinite(a.timestamp) ? a.timestamp : 0) -
        (Number.isFinite(b.timestamp) ? b.timestamp : 0) || a.index - b.index,
  );

  const path = [];
  for (const fix of fixes) {
    const last = path.at(-1);
    if (last && last[0] === fix.lat && last[1] === fix.lon) {
      continue;
    }
    path.push([fix.lat, fix.lon]);
  }
  return path;
}

// One path per recording, so the end of one walk isn't joined to the start of the next.
function extractPaths(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = row.recording_id ?? null;
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(row);
  }
  return [...groups.entries()]
    .map(([recordingId, groupRows]) => ({
      recordingId,
      points: extractPath(groupRows),
    }))
    .filter((item) => item.points.length > 0);
}

function pointsFromTrack(track) {
  const path = [];
  for (const point of track ?? []) {
    const lat = Number(point.lat);
    const lon = Number(point.lon);
    if (!isValidCoordinate(lat, lon)) {
      continue;
    }
    const last = path.at(-1);
    if (last && last[0] === lat && last[1] === lon) {
      continue;
    }
    path.push([lat, lon]);
  }
  return path;
}

function pathForRecording(recording) {
  const fromTrack = pointsFromTrack(recording.track);
  if (fromTrack.length) {
    return fromTrack;
  }
  const start = recording.start_gps;
  if (start != null) {
    const lat = Number(start.lat);
    const lon = Number(start.lon);
    if (isValidCoordinate(lat, lon)) {
      return [[lat, lon]];
    }
  }
  return [];
}

// Prefer per-recording GPS tracks; fall back to detection-row GPS for older sessions.
function extractRecordingPaths(recordings, rows) {
  const fromTracks = (recordings ?? [])
    .map((recording) => ({
      recordingId: recording.recording_id,
      points: pathForRecording(recording),
      recording,
    }))
    .filter((item) => item.points.length > 0);
  if (fromTracks.length) {
    return fromTracks;
  }
  return extractPaths(rows).map((item) => ({ ...item, recording: null }));
}

// Fixed colors first, then FNV-1a over the label name, so a label keeps its color across sessions.
function labelColor(label) {
  const fixed = FIXED_LABEL_COLORS.get(label.toLowerCase());
  if (fixed) {
    return fixed;
  }

  let hash = 0x811c9dc5;
  for (let i = 0; i < label.length; i += 1) {
    hash ^= label.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return LABEL_PALETTE[(hash >>> 0) % LABEL_PALETTE.length];
}

function readCoordinate(lat, lon) {
  if (lat == null || lon == null) {
    return null;
  }
  const point = [Number(lat), Number(lon)];
  return isValidCoordinate(...point) ? point : null;
}

function viewerPosition(row) {
  const point = readCoordinate(row.lat, row.lon);
  return point && { lat: point[0], lon: point[1] };
}

// Rows without an estimate are skipped, so "Where objects were" only shows projected detections.
function objectPosition(row) {
  const estimate = readCoordinate(row.est_lat, row.est_lon);
  const viewer = readCoordinate(row.lat, row.lon);
  if (!estimate || !viewer) {
    return null;
  }
  return {
    lat: estimate[0],
    lon: estimate[1],
    viewer,
    distance: row.distance_m == null ? null : Number(row.distance_m),
  };
}

function extractDetectionPoints(rows, positionOf, { labelView = "raw" } = {}) {
  const points = new Map();
  const labelCounts = new Map();
  const coannotated = labelView === "coannotated";

  for (const row of rows) {
    if (!isAiRow(row)) {
      continue;
    }
    const position = positionOf(row);
    const label = typeof row.label === "string" ? row.label.trim() : "";
    if (!position || !label) {
      continue;
    }

    const suppression = coannotated
      ? getLabelSuppressionAt(label, position.lat, position.lon, rows)
      : null;
    if (suppression?.action === "replace") {
      continue;
    }

    labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);

    const { lat, lon, ...extras } = position;
    const key = `${lat.toFixed(DEDUPE_DECIMALS)},${lon.toFixed(DEDUPE_DECIMALS)},${label}`;
    const confidence = Number(row.confidence);
    const existing = points.get(key);
    if (existing) {
      existing.count += 1;
      // Distance and viewer position follow the highest-confidence sighting.
      if (Number.isFinite(confidence) && !(confidence <= existing.confidence)) {
        existing.confidence = confidence;
        Object.assign(existing, extras);
      }
      if (suppression?.action === "delete") {
        existing.deleted = true;
      }
      continue;
    }
    points.set(key, {
      lat,
      lon,
      ...extras,
      label,
      confidence: Number.isFinite(confidence) ? confidence : null,
      count: 1,
      deleted: suppression?.action === "delete",
    });
  }

  const labels = [...labelCounts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  const colors = new Map(labels.map((item) => [item.label, labelColor(item.label)]));
  const rank = new Map(labels.map((item, index) => [item.label, index]));

  // Most frequent labels are drawn first so rarer labels sit on top and stay clickable.
  const dots = [...points.values()].sort(
    (a, b) => rank.get(a.label) - rank.get(b.label),
  );

  return { dots, labels, colors };
}

function extractUserAnnotations(rows, { labelView = "raw" } = {}) {
  const points = [];
  for (const row of rows) {
    if (!isUserAnnotationRow(row)) {
      continue;
    }
    const action = row.action || "add";
    if (action === "delete") {
      continue;
    }
    // Replace markers only appear in the co-annotated machine-label view.
    if (action === "replace" && labelView !== "coannotated") {
      continue;
    }
    const position = readCoordinate(row.lat, row.lon);
    if (!position) {
      continue;
    }
    const text =
      (typeof row.user_annotation === "string" && row.user_annotation.trim()) ||
      (typeof row.label === "string" && row.label.trim()) ||
      "";
    if (!text) {
      continue;
    }
    points.push({
      lat: position[0],
      lon: position[1],
      text,
      action,
      about: row.refers_to_label || null,
      nearby: Array.isArray(row.nearby_ai_labels)
        ? row.nearby_ai_labels
        : String(row.nearby_ai_labels ?? "")
            .split(/[;,]/)
            .map((item) => item.trim())
            .filter(Boolean),
      timestamp: Number(row.timestamp),
    });
  }
  return points;
}

function themeColor(name, fallback) {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return value || fallback;
}

function destroyMap() {
  // map.remove() fires overlayremove; unbind first so the saved layer choices survive.
  map?.off("baselayerchange overlayadd overlayremove");
  map?.remove();
  map = null;
  layers = null;
}

function userAnnotationPopup(point) {
  const content = document.createElement("div");
  const title = document.createElement("p");
  title.className = "map-popup__title";
  title.textContent = point.text;
  content.appendChild(title);

  if (point.action === "replace" && point.about) {
    const about = document.createElement("p");
    about.className = "map-popup__note";
    about.textContent = `Replaced: ${point.about}`;
    content.appendChild(about);
  } else if (point.about) {
    const about = document.createElement("p");
    about.className = "map-popup__note";
    about.textContent = `About: ${point.about}`;
    content.appendChild(about);
  }

  if (point.nearby?.length) {
    const nearby = document.createElement("p");
    nearby.className = "map-popup__note";
    nearby.textContent = `Nearby AI: ${point.nearby.join(", ")}`;
    content.appendChild(nearby);
  }
  return content;
}

function detectionPopup(dot, stackSize, kind) {
  const content = document.createElement("div");
  const title = document.createElement("p");
  title.className = "map-popup__title";
  const confidence =
    dot.confidence === null ? "—" : dot.confidence.toFixed(2);
  const distance =
    dot.distance == null ? "" : ` · ~${Math.round(dot.distance)} m`;
  title.textContent = `${dot.label} — ${confidence}${distance}`;
  content.appendChild(title);

  const where = document.createElement("p");
  where.className = "map-popup__note";
  where.textContent =
    kind === "objects" ? "Estimated object position" : "Your position";
  content.appendChild(where);

  if (dot.count > 1) {
    const note = document.createElement("p");
    note.className = "map-popup__note";
    note.textContent = `Highest of ${dot.count} detections here`;
    content.appendChild(note);
  }

  if (stackSize > 1) {
    const stacked = document.createElement("p");
    stacked.className = "map-popup__note";
    stacked.textContent = `Stacked: ${stackSize} labels at this spot`;
    content.appendChild(stacked);
  }
  return content;
}

function fanOffset(index, count) {
  const radius = Math.max(
    FAN_MIN_RADIUS_PX,
    (count * FAN_SPACING_PX) / (2 * Math.PI),
  );
  const angle = -Math.PI / 2 + (2 * Math.PI * index) / count;
  return [radius * Math.cos(angle), radius * Math.sin(angle)];
}

function drawDots(L, detections, kind, panel) {
  const layer = L.layerGroup();
  const groups = new Map();
  for (const dot of detections.dots) {
    const key = `${dot.lat.toFixed(DEDUPE_DECIMALS)},${dot.lon.toFixed(DEDUPE_DECIMALS)}`;
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(dot);
  }

  const fanned = [];
  for (const group of groups.values()) {
    const center = L.latLng(group[0].lat, group[0].lon);
    group.forEach((dot, index) => {
      // Label text is set as a text node; Leaflet would parse a string as HTML.
      const marker = L.circleMarker(center, {
        pane: "mapDots",
        radius: 5,
        color: panel,
        weight: 1,
        fillColor: AI_MARKER_COLOR,
        fillOpacity: dot.deleted ? 0.35 : 0.9,
        opacity: dot.deleted ? 0.5 : 1,
      })
        .bindPopup(detectionPopup(dot, group.length, kind))
        .bindTooltip(document.createTextNode(dot.label), {
          permanent: true,
          direction: "right",
          offset: [6, 0],
          className: dot.deleted
            ? "map-dot-label map-dot-label--deleted"
            : "map-dot-label",
        })
        .addTo(layer);
      if (group.length > 1) {
        fanned.push({ marker, center, offset: L.point(fanOffset(index, group.length)) });
      }
    });
  }
  return { layer, fanned };
}

function drawUserAnnotations(L, points, panel) {
  const layer = L.layerGroup();
  for (const point of points) {
    L.circleMarker([point.lat, point.lon], {
      pane: "mapDots",
      radius: 8,
      color: panel,
      weight: 2,
      fillColor: USER_MARKER_COLOR,
      fillOpacity: 0.95,
    })
      .bindPopup(userAnnotationPopup(point))
      .bindTooltip(document.createTextNode(point.text), {
        permanent: true,
        direction: "right",
        offset: [8, 0],
        className: "map-dot-label",
      })
      .addTo(layer);
  }
  return layer;
}

function placeFanned(fanned) {
  const zoom = map.getZoom();
  for (const item of fanned) {
    const point = map.project(item.center, zoom).add(item.offset);
    item.marker.setLatLng(map.unproject(point, zoom));
  }
}

function drawSightLines(L, detections) {
  const layer = L.layerGroup();
  for (const dot of detections.dots) {
    L.polyline([dot.viewer, [dot.lat, dot.lon]], {
      pane: "mapLines",
      color: AI_MARKER_COLOR,
      weight: 1.5,
      opacity: 0.4,
      interactive: false,
    }).addTo(layer);
  }
  return layer;
}

function pathStyle(index) {
  const color = PATH_PALETTE[index % PATH_PALETTE.length];
  return index < PATH_PALETTE.length ? { color } : { color, dashArray: "8 6" };
}

function momentStartLatLng(recording, points) {
  const start = recording?.start_gps;
  if (start != null) {
    const lat = Number(start.lat);
    const lon = Number(start.lon);
    if (isValidCoordinate(lat, lon)) {
      return [lat, lon];
    }
  }
  return points[0] ?? null;
}

function drawPaths(L, paths, accent) {
  const layer = L.layerGroup();
  const named = paths.length > 1;
  const recordings = [];

  paths.forEach(({ recordingId, points, recording }, index) => {
    const name = `Recording ${recordingId}`;
    const prefix = named ? `${name} · ` : "";
    const style = named ? pathStyle(index) : { color: accent };

    if (points.length > 1) {
      L.polyline(points, { pane: "mapPath", weight: 4, opacity: 0.9, ...style }).addTo(layer);
    }

    // Hollow rings mark the location without covering detections.
    // Different radii keep both rings visible when start and end coincide.
    L.circleMarker(points[0], {
      pane: "mapPath",
      radius: 10,
      color: "#16a34a",
      weight: 3,
      fill: false,
    })
      .bindTooltip(`${prefix}Start`)
      .addTo(layer);

    if (points.length > 1) {
      L.circleMarker(points.at(-1), {
        pane: "mapPath",
        radius: 7,
        color: "#dc2626",
        weight: 3,
        fill: false,
      })
        .bindTooltip(`${prefix}End`)
        .addTo(layer);
    }

    const momentAt = momentStartLatLng(recording, points);
    if (momentAt && recording) {
      const label = `Recording ${recording.recording_id} · ${formatClockTime(recording.start_time)}`;
      L.circleMarker(momentAt, {
        pane: "mapPath",
        radius: 6,
        color: style.color ?? accent,
        weight: 2,
        fillColor: "#ffffff",
        fillOpacity: 1,
      })
        .bindTooltip(label, {
          permanent: true,
          direction: "top",
          offset: [0, -8],
          className: "map-moment-label",
        })
        .addTo(layer);
    }

    if (named) {
      recordings.push({ name, ...style });
    }
  });
  return { layer, recordings };
}

function fitView(points) {
  if (points.length > 1) {
    map.fitBounds(points, { padding: [32, 32] });
  } else {
    map.setView(points[0], SINGLE_POINT_ZOOM);
  }
}

function legendGroup(title, items) {
  const group = document.createElement("div");
  group.className = "map-legend__group";

  const heading = document.createElement("p");
  heading.className = "map-legend__title";
  heading.textContent = title;

  const list = document.createElement("ul");
  list.className = "map-legend__list";
  for (const item of items) {
    const row = document.createElement("li");
    row.className = "map-legend__item";
    const name = document.createElement("span");
    name.className = "map-legend__label";
    name.textContent = item.name;
    row.append(item.swatch, name);
    if (item.count != null) {
      const count = document.createElement("span");
      count.className = "map-legend__count";
      count.textContent = String(item.count);
      row.appendChild(count);
    }
    list.appendChild(row);
  }

  group.append(heading, list);
  return group;
}

// Rendered below the map rather than as a Leaflet control: controls always stack above popups.
function renderLegend(legend, recordings, detections) {
  const groups = [];

  if (recordings.length) {
    groups.push(
      legendGroup(
        "Recordings",
        recordings.map((recording) => {
          const swatch = document.createElement("span");
          swatch.className = "map-legend__swatch map-legend__swatch--line";
          swatch.style.borderTopColor = recording.color;
          if (recording.dashArray) {
            swatch.style.borderTopStyle = "dashed";
          }
          return { swatch, name: recording.name };
        }),
      ),
    );
  }

  if (detections?.labels.length) {
    const group = legendGroup(
      "Labels",
      detections.labels.slice(0, LEGEND_LIMIT).map((item) => {
        const swatch = document.createElement("span");
        swatch.className = "map-legend__swatch";
        swatch.style.backgroundColor = AI_MARKER_COLOR;
        return { swatch, name: item.label, count: item.count };
      }),
    );
    const hidden = detections.labels.length - LEGEND_LIMIT;
    if (hidden > 0) {
      const more = document.createElement("p");
      more.className = "map-legend__more";
      more.textContent = `+${hidden} more ${hidden === 1 ? "label" : "labels"}`;
      group.appendChild(more);
    }
    groups.push(group);
  }

  legend.replaceChildren(...groups);
  legend.classList.toggle("hidden", groups.length === 0);
}

function drawMap(L, container, paths, snapshot, onChange) {
  destroyMap();
  // No tile layer under "None", so the map needs its own zoom limit.
  map = L.map(container, { zoomControl: true, maxZoom: MAX_ZOOM });
  // Fixed panes keep path < sight lines < dots when layers are toggled off and on again.
  map.createPane("mapPath").style.zIndex = "410";
  map.createPane("mapLines").style.zIndex = "420";
  map.createPane("mapDots").style.zIndex = "430";

  const panel = themeColor("--color-bg-panel", "#ffffff");
  const viewer = drawDots(L, snapshot.viewer, "viewer", panel);
  const objects = drawDots(L, snapshot.objects, "objects", panel);
  const userAnnotations = drawUserAnnotations(
    L,
    snapshot.userAnnotations,
    panel,
  );
  const path = drawPaths(L, paths, themeColor("--color-accent", "#2563eb"));

  const bases = {
    street: L.tileLayer(TILE_URL, {
      maxZoom: MAX_ZOOM,
      attribution: TILE_ATTRIBUTION,
    }),
    none: L.layerGroup(),
  };
  const overlays = {
    path: path.layer,
    viewer: viewer.layer,
    objects: objects.layer,
    sightLines: drawSightLines(L, snapshot.objects),
    // Empty; only switches the label CSS class.
    labels: L.layerGroup(),
    userAnnotations,
  };

  bases[layerState.base].addTo(map);
  for (const key of layerState.overlays) {
    overlays[key].addTo(map);
  }

  const keyOf = new Map(
    [...Object.entries(bases), ...Object.entries(overlays)].map(
      ([key, layer]) => [layer, key],
    ),
  );
  // Added after the saved layers so the control starts with the right boxes ticked.
  L.control
    .layers(
      { "Street map": bases.street, None: bases.none },
      Object.fromEntries(OVERLAYS.map(([key, name]) => [name, overlays[key]])),
      { position: "topright", collapsed: window.matchMedia(PHONE_QUERY).matches },
    )
    .addTo(map);

  map.on("baselayerchange", (event) => {
    layerState.base = keyOf.get(event.layer);
  });
  map.on("overlayadd overlayremove", (event) => {
    const key = keyOf.get(event.layer);
    if (event.type === "overlayadd") {
      layerState.overlays.add(key);
    } else {
      layerState.overlays.delete(key);
    }
    onChange();
  });

  const fanned = [...viewer.fanned, ...objects.fanned];
  map.on("zoomend", () => {
    placeFanned(fanned);
    onChange();
  });

  layers = {
    recordings: path.recordings,
    placeFanned: () => placeFanned(fanned),
  };
}

// The Review panel decides when the map is visible; this only builds, clears, and re-measures it.
export function initSessionMap() {
  const empty = document.getElementById("map-empty");
  const errorNote = document.getElementById("map-error");
  const canvas = document.getElementById("map-canvas");
  const legend = document.getElementById("map-legend");
  const objectsEmpty = document.getElementById("map-objects-empty");
  const labelViewSelect = document.getElementById("map-label-view");

  if (!empty || !errorNote || !canvas || !legend || !objectsEmpty) {
    return null;
  }

  let snapshot = null;
  let activeSelection = null;
  // Path points and object estimates, so turning a layer on never needs a refit.
  let fitPoints = [];
  let fitPending = false;

  if (labelViewSelect) {
    labelViewSelect.value = layerState.labelView;
  }

  function syncLayers() {
    if (!map) {
      return;
    }
    const on = layerState.overlays;
    const zoomedIn = map.getZoom() >= LABEL_MIN_ZOOM;
    canvas.classList.toggle("map--zoomed-in", zoomedIn);
    canvas.classList.toggle("map--labels", zoomedIn && on.has("labels"));
    objectsEmpty.classList.toggle(
      "hidden",
      !on.has("objects") || snapshot.objects.dots.length > 0,
    );
    // Every estimate row also has a viewer position, so the viewer labels cover both dot layers.
    const dots = on.has("viewer")
      ? snapshot.viewer
      : on.has("objects")
        ? snapshot.objects
        : null;
    renderLegend(legend, on.has("path") ? layers.recordings : [], dots);
    // The legend and note change the canvas height; Leaflet caches its size.
    map.invalidateSize();
  }

  function fit() {
    syncLayers();
    fitView(fitPoints);
    layers.placeFanned();
  }

  function clearLegend() {
    legend.replaceChildren();
    legend.classList.add("hidden");
  }

  function close() {
    openGeneration += 1;
    fitPending = false;
    activeSelection = null;
    destroyMap();
    clearLegend();
    objectsEmpty.classList.add("hidden");
    canvas.classList.remove("map--zoomed-in", "map--labels");
  }

  async function open(selection) {
    const generation = ++openGeneration;
    activeSelection = selection;
    const rows = selection.rows;
    const labelView = layerState.labelView;
    const paths = extractRecordingPaths(selection.recordings, rows);
    const path = paths.flatMap((item) => item.points);
    snapshot = {
      viewer: extractDetectionPoints(rows, viewerPosition, { labelView }),
      objects: extractDetectionPoints(rows, objectPosition, { labelView }),
      userAnnotations: extractUserAnnotations(rows, { labelView }),
    };
    fitPoints = [
      ...path,
      ...snapshot.objects.dots.map((dot) => [dot.lat, dot.lon]),
      ...snapshot.userAnnotations.map((point) => [point.lat, point.lon]),
    ];
    errorNote.classList.add("hidden");
    objectsEmpty.classList.add("hidden");
    clearLegend();

    const hasPath = path.length > 0;
    empty.classList.toggle("hidden", hasPath);
    canvas.classList.toggle("hidden", !hasPath);
    if (!hasPath) {
      destroyMap();
      return;
    }

    try {
      const L = await loadLeaflet();
      if (generation !== openGeneration || !L) {
        return;
      }
      drawMap(L, canvas, paths, snapshot, syncLayers);
      // The tab may have been hidden while Leaflet loaded; fit again once it is shown.
      fitPending = canvas.offsetWidth === 0;
      fit();
    } catch (error) {
      console.error("[MAP] map failed:", error);
      if (generation !== openGeneration) {
        return;
      }
      destroyMap();
      canvas.classList.add("hidden");
      errorNote.classList.remove("hidden");
    }
  }

  // Leaflet caches its size, so re-measure after the tab is shown again.
  function resize() {
    if (!map) {
      return;
    }
    map.invalidateSize();
    if (fitPending) {
      fitPending = false;
      fit();
    }
  }

  labelViewSelect?.addEventListener("change", () => {
    layerState.labelView =
      labelViewSelect.value === "raw" ? "raw" : "coannotated";
    if (activeSelection) {
      void open(activeSelection);
    }
  });

  return { open, close, resize };
}
