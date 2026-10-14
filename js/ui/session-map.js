// On-demand map of the walked GPS path and detections from the in-memory detection log. Read-only.
const LEAFLET_CSS =
  "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css";
const LEAFLET_JS =
  "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js";
const TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const SINGLE_POINT_ZOOM = 18;
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

let map = null;
let detectionLayer = null;
let fanListener = null;
let leafletLoader = null;
let openGeneration = 0;
let mapMode = "viewer";

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

function extractDetectionPoints(rows, positionOf) {
  const points = new Map();
  const labelCounts = new Map();

  for (const row of rows) {
    const position = positionOf(row);
    const label = typeof row.label === "string" ? row.label.trim() : "";
    if (!position || !label) {
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
      continue;
    }
    points.set(key, {
      lat,
      lon,
      ...extras,
      label,
      confidence: Number.isFinite(confidence) ? confidence : null,
      count: 1,
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

function themeColor(name, fallback) {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return value || fallback;
}

function destroyMap() {
  map?.remove();
  map = null;
  detectionLayer = null;
  fanListener = null;
}

function detectionPopup(dot, stackSize) {
  const content = document.createElement("div");
  const title = document.createElement("p");
  title.className = "map-popup__title";
  const confidence =
    dot.confidence === null ? "—" : dot.confidence.toFixed(2);
  const distance =
    dot.distance == null ? "" : ` · ~${Math.round(dot.distance)} m`;
  title.textContent = `${dot.label} — ${confidence}${distance}`;
  content.appendChild(title);

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

function drawDetections(L, detections, panel) {
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
      const marker = L.circleMarker(center, {
        radius: 5,
        color: panel,
        weight: 1,
        fillColor: detections.colors.get(dot.label),
        fillOpacity: 0.9,
      })
        .bindPopup(detectionPopup(dot, group.length))
        .addTo(detectionLayer);
      if (group.length > 1) {
        fanned.push({ marker, center, offset: L.point(fanOffset(index, group.length)) });
      }
    });
  }

  function placeFanned() {
    const zoom = map.getZoom();
    for (const item of fanned) {
      const point = map.project(item.center, zoom).add(item.offset);
      item.marker.setLatLng(map.unproject(point, zoom));
    }
  }

  placeFanned();
  map.on("zoomend", placeFanned);
  return placeFanned;
}

// Drawn before the dots so the dots stay on top and clickable.
function drawSightLines(L, detections) {
  for (const dot of detections.dots) {
    L.polyline([dot.viewer, [dot.lat, dot.lon]], {
      color: detections.colors.get(dot.label),
      weight: 1.5,
      opacity: 0.4,
      interactive: false,
    }).addTo(detectionLayer);
  }
}

function fitView(points) {
  if (points.length > 1) {
    map.fitBounds(points, { padding: [32, 32] });
  } else {
    map.setView(points[0], SINGLE_POINT_ZOOM);
  }
}

function showDetections(L, mode, path, snapshot) {
  if (fanListener) {
    map.off("zoomend", fanListener);
  }
  detectionLayer.clearLayers();
  const detections = snapshot[mode];
  if (mode === "objects") {
    drawSightLines(L, detections);
    fitView([...path, ...detections.dots.map((dot) => [dot.lat, dot.lon])]);
  } else {
    fitView(path);
  }
  fanListener = drawDetections(
    L,
    detections,
    themeColor("--color-bg-panel", "#ffffff"),
  );
}

// Rendered below the map rather than as a Leaflet control: controls always stack above popups.
function renderLegend(legend, detections) {
  legend.replaceChildren();
  legend.classList.toggle("hidden", detections.labels.length === 0);
  if (!detections.labels.length) {
    return;
  }

  const heading = document.createElement("p");
  heading.className = "map-legend__title";
  heading.textContent = "Labels";

  const list = document.createElement("ul");
  list.className = "map-legend__list";
  for (const item of detections.labels.slice(0, LEGEND_LIMIT)) {
    const row = document.createElement("li");
    row.className = "map-legend__item";
    const swatch = document.createElement("span");
    swatch.className = "map-legend__swatch";
    swatch.style.backgroundColor = detections.colors.get(item.label);
    const name = document.createElement("span");
    name.className = "map-legend__label";
    name.textContent = item.label;
    const count = document.createElement("span");
    count.className = "map-legend__count";
    count.textContent = String(item.count);
    row.append(swatch, name, count);
    list.appendChild(row);
  }

  legend.append(heading, list);

  const hidden = detections.labels.length - LEGEND_LIMIT;
  if (hidden > 0) {
    const more = document.createElement("p");
    more.className = "map-legend__more";
    more.textContent = `+${hidden} more ${hidden === 1 ? "label" : "labels"}`;
    legend.appendChild(more);
  }
}

function drawMap(L, container, paths) {
  destroyMap();
  map = L.map(container, { zoomControl: true });
  L.tileLayer(TILE_URL, {
    maxZoom: 19,
    attribution: TILE_ATTRIBUTION,
  }).addTo(map);

  const accent = themeColor("--color-accent", "#2563eb");
  const named = paths.length > 1;

  for (const { recordingId, points } of paths) {
    const prefix = named ? `Recording ${recordingId} · ` : "";

    if (points.length > 1) {
      L.polyline(points, { color: accent, weight: 4, opacity: 0.9 }).addTo(map);
    }

    // Hollow rings drawn before the dots so they mark the location without covering detections.
    // Different radii keep both rings visible when start and end coincide.
    L.circleMarker(points[0], {
      radius: 10,
      color: "#16a34a",
      weight: 3,
      fill: false,
    })
      .bindTooltip(`${prefix}Start`)
      .addTo(map);

    if (points.length > 1) {
      L.circleMarker(points.at(-1), {
        radius: 7,
        color: "#dc2626",
        weight: 3,
        fill: false,
      })
        .bindTooltip(`${prefix}End`)
        .addTo(map);
    }
  }

  // Added after the rings so detections draw above them.
  detectionLayer = L.layerGroup().addTo(map);
}

// The Review panel decides when the map is visible; this only builds, clears, and re-measures it.
export function initSessionMap() {
  const empty = document.getElementById("map-empty");
  const errorNote = document.getElementById("map-error");
  const canvas = document.getElementById("map-canvas");
  const legend = document.getElementById("map-legend");
  const modeGroup = document.getElementById("map-mode");
  const objectsEmpty = document.getElementById("map-objects-empty");

  if (
    !empty ||
    !errorNote ||
    !canvas ||
    !legend ||
    !modeGroup ||
    !objectsEmpty
  ) {
    return null;
  }

  const modeButtons = [...modeGroup.querySelectorAll("[data-map-mode]")];
  let leaflet = null;
  let paths = [];
  // Every path point together, for fitting the view.
  let path = [];
  let snapshot = null;
  let fitPending = false;

  function renderMode() {
    for (const option of modeButtons) {
      option.setAttribute(
        "aria-pressed",
        String(option.dataset.mapMode === mapMode),
      );
    }
    objectsEmpty.classList.toggle(
      "hidden",
      !map || mapMode !== "objects" || snapshot.objects.dots.length > 0,
    );
    if (!map) {
      return;
    }
    showDetections(leaflet, mapMode, path, snapshot);
    renderLegend(legend, snapshot[mapMode]);
  }

  function clearLegend() {
    legend.replaceChildren();
    legend.classList.add("hidden");
  }

  function close() {
    openGeneration += 1;
    fitPending = false;
    destroyMap();
    clearLegend();
    modeGroup.classList.add("hidden");
    objectsEmpty.classList.add("hidden");
  }

  async function open(selection) {
    const generation = ++openGeneration;
    const rows = selection.rows;
    paths = extractPaths(rows);
    path = paths.flatMap((item) => item.points);
    snapshot = {
      viewer: extractDetectionPoints(rows, viewerPosition),
      objects: extractDetectionPoints(rows, objectPosition),
    };
    errorNote.classList.add("hidden");
    objectsEmpty.classList.add("hidden");
    clearLegend();

    const hasPath = path.length > 0;
    empty.classList.toggle("hidden", hasPath);
    canvas.classList.toggle("hidden", !hasPath);
    modeGroup.classList.toggle("hidden", !hasPath);
    if (!hasPath) {
      destroyMap();
      return;
    }

    try {
      const L = await loadLeaflet();
      if (generation !== openGeneration || !L) {
        return;
      }
      leaflet = L;
      drawMap(L, canvas, paths);
      // The tab may have been hidden while Leaflet loaded; fit again once it is shown.
      fitPending = canvas.offsetWidth === 0;
      renderMode();
    } catch (error) {
      console.error("[MAP] map failed:", error);
      if (generation !== openGeneration) {
        return;
      }
      destroyMap();
      canvas.classList.add("hidden");
      modeGroup.classList.add("hidden");
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
      renderMode();
    }
  }

  for (const option of modeButtons) {
    option.addEventListener("click", () => {
      if (option.dataset.mapMode === mapMode) {
        return;
      }
      mapMode = option.dataset.mapMode;
      renderMode();
    });
  }

  return { open, close, resize };
}
