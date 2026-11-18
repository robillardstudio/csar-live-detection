// On-demand map of the walked GPS path and detections from the in-memory detection log.
import { logLabelReplace } from "../live/detection-log.js";

const LEAFLET_CSS =
  "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css";
const LEAFLET_JS =
  "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js";
const OSM_TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const OSM_TILE_ATTRIBUTION = "© OpenStreetMap contributors";
const SINGLE_POINT_ZOOM = 18;
const MAX_ZOOM = 19;
// Below this zoom, dots are too close together for readable labels.
const LABEL_MIN_ZOOM = 18;
const PHONE_QUERY = "(max-width: 640px)";
const OVERLAYS = [
  ["path", "Walking path"],
  ["viewer", "Where I was"],
  ["objects", "Where objects were"],
  ["sightLines", "Sight lines"],
  ["labels", 'Labels <span class="map-layers__hint">(zoom in)</span>'],
];
const COLOR_AI = "#39E58C";
const COLOR_USER = "#FF8A2A";
const PATH_COLOR = "#ffffff";
const PATH_OPACITY = 0.25;
const PATH_WEIGHT = 1.5;
const LEGEND_LIMIT = 8;
// 5 decimal places is ~1 m, finer than phone GPS accuracy.
const DEDUPE_DECIMALS = 5;
// Screen-space spread for dots that share a location; recomputed on zoom so it stays constant in pixels.
const FAN_MIN_RADIUS_PX = 16;
// Arc length reserved per fanned dot: dot diameter plus a small gap.
const FAN_SPACING_PX = 13;

// Kept for the page visit across tabs, recordings and mode switches; no storage.
const layerState = { base: "dark", overlays: new Set(["path", "viewer"]) };

function dotRadiusForZoom(zoom) {
  if (zoom <= 16) {
    return 3;
  }
  if (zoom <= 18) {
    return 4;
  }
  return 6;
}
let labelView = "changes";

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

function isGoodGpsRow(row) {
  if (row.gps_quality === "low") {
    return false;
  }
  if (row.gps_quality === "good") {
    return true;
  }
  const accuracy = Number(row.gps_accuracy);
  return !Number.isFinite(accuracy) || accuracy <= 25;
}

function extractPath(rows) {
  const fixes = [];
  rows.forEach((row, index) => {
    if (row.lat == null || row.lon == null || !isGoodGpsRow(row)) {
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

// Latest replace/delete per AI row id; later actions win.
function latestOverrides(rows) {
  const overrides = new Map();
  for (const row of rows) {
    if (
      row.source === "user" &&
      (row.action === "replace" || row.action === "delete") &&
      row.refers_to_row != null
    ) {
      overrides.set(row.refers_to_row, row);
    }
  }
  return overrides;
}

function addDot(points, labelCounts, position, fields) {
  const { lat, lon, ...extras } = position;
  const kind = fields.deleted ? "d" : fields.changed ? "u" : "a";
  const key = `${lat.toFixed(DEDUPE_DECIMALS)},${lon.toFixed(DEDUPE_DECIMALS)},${fields.label},${kind}`;
  labelCounts.set(fields.label, (labelCounts.get(fields.label) ?? 0) + 1);
  const confidence = Number(fields.confidence);
  const existing = points.get(key);
  if (existing) {
    existing.count += 1;
    if (Number.isFinite(confidence) && !(confidence <= existing.confidence)) {
      Object.assign(existing, extras, fields, {
        confidence: Number.isFinite(confidence) ? confidence : null,
      });
    }
    return;
  }
  points.set(key, {
    lat,
    lon,
    ...extras,
    ...fields,
    confidence: Number.isFinite(confidence) ? confidence : null,
    count: 1,
  });
}

function extractDetectionPoints(rows, positionOf, withChanges) {
  const points = new Map();
  const labelCounts = new Map();
  const overrides = latestOverrides(rows);

  for (const row of rows) {
    if (row.source === "user") {
      continue;
    }
    const position = positionOf(row);
    const aiLabel = typeof row.label === "string" ? row.label.trim() : "";
    if (!position || !aiLabel) {
      continue;
    }

    const override = withChanges ? overrides.get(row.id) : null;
    if (override?.action === "delete") {
      addDot(points, labelCounts, position, {
        label: aiLabel,
        aiLabel,
        userLabel: null,
        changed: false,
        deleted: true,
        row,
        confidence: row.confidence,
      });
      continue;
    }
    const replace = override?.action === "replace" ? override : null;
    const label = replace
      ? String(replace.label ?? "").trim() || aiLabel
      : aiLabel;
    addDot(points, labelCounts, position, {
      label,
      aiLabel,
      userLabel: replace?.label ?? null,
      changed: Boolean(replace),
      deleted: false,
      row,
      confidence: row.confidence,
    });
  }

  if (withChanges) {
    for (const row of rows) {
      if (row.source !== "user" || row.action !== "add") {
        continue;
      }
      const label = typeof row.label === "string" ? row.label.trim() : "";
      const position = positionOf(row);
      if (!position || !label) {
        continue;
      }
      addDot(points, labelCounts, position, {
        label,
        aiLabel: row.refers_to_label ?? label,
        userLabel: label,
        changed: true,
        deleted: false,
        row: null,
        confidence: null,
      });
    }
  }

  const labels = [...labelCounts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  const rank = new Map(labels.map((item, index) => [item.label, index]));

  // Most frequent labels are drawn first so rarer labels sit on top and stay clickable.
  const dots = [...points.values()].sort(
    (a, b) => rank.get(a.label) - rank.get(b.label),
  );

  return { dots, labels };
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

  if (dot.deleted) {
    const deleted = document.createElement("p");
    deleted.className = "map-popup__note";
    deleted.textContent = "Deleted";
    content.appendChild(deleted);
  } else if (dot.changed && dot.userLabel && dot.row) {
    const changeNote = document.createElement("p");
    changeNote.className = "map-popup__note";
    changeNote.textContent = `AI said: ${dot.aiLabel} → changed to: ${dot.userLabel}`;
    content.appendChild(changeNote);
  } else if (dot.changed && !dot.row) {
    const added = document.createElement("p");
    added.className = "map-popup__note";
    added.textContent = "User added";
    content.appendChild(added);
  }

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

  if (dot.row) {
    const actions = document.createElement("div");
    actions.className = "map-popup__actions";
    const changeBtn = document.createElement("button");
    changeBtn.type = "button";
    changeBtn.className = "map-popup__change";
    changeBtn.textContent = "Change label";
    actions.appendChild(changeBtn);
    content.appendChild(actions);

    changeBtn.addEventListener("click", () => {
      actions.replaceChildren();
      const form = document.createElement("form");
      form.className = "map-popup__form";
      const input = document.createElement("input");
      input.type = "text";
      input.className = "map-popup__input";
      input.value = dot.aiLabel;
      input.setAttribute("aria-label", "New label");
      const save = document.createElement("button");
      save.type = "submit";
      save.className = "map-popup__save";
      save.textContent = "Save";
      form.append(input, save);
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        const next = input.value.trim();
        if (!next || !dot.row) {
          return;
        }
        logLabelReplace(dot.row, next);
        map?.closePopup();
      });
      actions.appendChild(form);
      input.focus();
      input.select();
    });
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

function dotStyle(dot, radius) {
  if (dot.deleted) {
    return {
      pane: "mapDots",
      radius,
      color: COLOR_USER,
      weight: 1.5,
      fill: false,
      fillOpacity: 0,
      className: "map-dot map-dot--deleted",
    };
  }
  const fill = dot.changed ? COLOR_USER : COLOR_AI;
  return {
    pane: "mapDots",
    radius,
    color: fill,
    weight: 0,
    fillColor: fill,
    fillOpacity: 0.85,
    className: `map-dot ${dot.changed ? "map-dot--user" : "map-dot--ai"}`,
  };
}

function drawDots(L, detections, kind) {
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
  const markers = [];
  const radius = dotRadiusForZoom(map?.getZoom?.() ?? SINGLE_POINT_ZOOM);
  for (const group of groups.values()) {
    const center = L.latLng(group[0].lat, group[0].lon);
    group.forEach((dot, index) => {
      // Label text is set as a text node; Leaflet would parse a string as HTML.
      const marker = L.circleMarker(center, dotStyle(dot, radius))
        .bindPopup(detectionPopup(dot, group.length, kind))
        .bindTooltip(document.createTextNode(dot.label), {
          permanent: true,
          direction: "right",
          offset: [6, 0],
          className: "map-dot-label",
        })
        .addTo(layer);
      markers.push(marker);
      if (group.length > 1) {
        fanned.push({ marker, center, offset: L.point(fanOffset(index, group.length)) });
      }
    });
  }
  return { layer, fanned, markers };
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
    if (!dot.viewer) {
      continue;
    }
    L.polyline([dot.viewer, [dot.lat, dot.lon]], {
      pane: "mapLines",
      color: dot.deleted || dot.changed ? COLOR_USER : COLOR_AI,
      weight: 1,
      opacity: 0.35,
      interactive: false,
    }).addTo(layer);
  }
  return layer;
}

function drawPaths(L, paths) {
  const layer = L.layerGroup();
  const named = paths.length > 1;
  const recordings = [];

  paths.forEach(({ recordingId, points }, index) => {
    const name = `Recording ${recordingId}`;
    const prefix = named ? `${name} · ` : "";
    const style = {
      color: PATH_COLOR,
      ...(index > 0 ? { dashArray: "4 6" } : {}),
    };

    if (points.length > 1) {
      L.polyline(points, {
        pane: "mapPath",
        weight: PATH_WEIGHT,
        opacity: PATH_OPACITY,
        ...style,
      }).addTo(layer);
    }

    L.circleMarker(points[0], {
      pane: "mapPath",
      radius: 3,
      color: "rgba(255,255,255,0.55)",
      weight: 1,
      fillColor: "rgba(255,255,255,0.3)",
      fillOpacity: 1,
      className: "map-path-endpoint",
    })
      .bindTooltip(`${prefix}Start`)
      .addTo(layer);

    if (points.length > 1) {
      L.circleMarker(points.at(-1), {
        pane: "mapPath",
        radius: 2.5,
        color: "rgba(255,255,255,0.4)",
        weight: 1,
        fillColor: "rgba(255,255,255,0.2)",
        fillOpacity: 1,
        className: "map-path-endpoint",
      })
        .bindTooltip(`${prefix}End`)
        .addTo(layer);
    }

    if (named) {
      recordings.push({ name, color: PATH_COLOR, dashArray: style.dashArray });
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

  if (detections?.dots.length) {
    const deletedCount = detections.dots.filter((dot) => dot.deleted).length;
    const changedCount = detections.dots.filter(
      (dot) => dot.changed && !dot.deleted,
    ).length;
    const aiCount = detections.dots.length - changedCount - deletedCount;
    const aiSwatch = document.createElement("span");
    aiSwatch.className = "map-legend__swatch";
    aiSwatch.style.backgroundColor = COLOR_AI;
    const userSwatch = document.createElement("span");
    userSwatch.className = "map-legend__swatch";
    userSwatch.style.backgroundColor = COLOR_USER;
    const deleteSwatch = document.createElement("span");
    deleteSwatch.className = "map-legend__swatch map-legend__swatch--ring";
    deleteSwatch.style.borderColor = COLOR_USER;
    const items = [
      { swatch: aiSwatch, name: "AI label", count: aiCount },
      { swatch: userSwatch, name: "User change", count: changedCount },
    ];
    if (deletedCount > 0) {
      items.push({ swatch: deleteSwatch, name: "Deleted", count: deletedCount });
    }
    groups.push(legendGroup("Annotation", items));
  }

  if (detections?.labels.length) {
    const group = legendGroup(
      "Labels",
      detections.labels.slice(0, LEGEND_LIMIT).map((item) => {
        const swatch = document.createElement("span");
        swatch.className = "map-legend__swatch";
        swatch.style.backgroundColor = COLOR_AI;
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

  const viewer = drawDots(L, snapshot.viewer, "viewer");
  const objects = drawDots(L, snapshot.objects, "objects");
  const path = drawPaths(L, paths);
  const allMarkers = [...viewer.markers, ...objects.markers];

  const bases = {
    dark: L.tileLayer(OSM_TILE_URL, {
      maxZoom: MAX_ZOOM,
      attribution: OSM_TILE_ATTRIBUTION,
      className: "tiles-dark",
    }),
    street: L.tileLayer(OSM_TILE_URL, {
      maxZoom: MAX_ZOOM,
      attribution: OSM_TILE_ATTRIBUTION,
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
  };

  if (!bases[layerState.base]) {
    layerState.base = "dark";
  }
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
      {
        Dark: bases.dark,
        Street: bases.street,
        None: bases.none,
      },
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
  function syncDotRadii() {
    const radius = dotRadiusForZoom(map.getZoom());
    for (const marker of allMarkers) {
      marker.setRadius(radius);
    }
  }
  map.on("zoomend", () => {
    syncDotRadii();
    placeFanned(fanned);
    onChange();
  });
  syncDotRadii();

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
  const labelViewToggle = document.getElementById("map-label-view");

  if (!empty || !errorNote || !canvas || !legend || !objectsEmpty) {
    return null;
  }

  let snapshot = null;
  let selectionRows = [];
  let selectionPaths = [];
  // Path points and object estimates, so turning a layer on never needs a refit.
  let fitPoints = [];
  let fitPending = false;

  function syncLabelViewToggle() {
    if (!labelViewToggle) {
      return;
    }
    for (const button of labelViewToggle.querySelectorAll("[data-label-view]")) {
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.labelView === labelView),
      );
    }
  }

  function buildSnapshot(rows) {
    const withChanges = labelView === "changes";
    return {
      viewer: extractDetectionPoints(rows, viewerPosition, withChanges),
      objects: extractDetectionPoints(rows, objectPosition, withChanges),
    };
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
    destroyMap();
    clearLegend();
    objectsEmpty.classList.add("hidden");
    canvas.classList.remove("map--zoomed-in", "map--labels");
  }

  async function open(selection) {
    const generation = ++openGeneration;
    const rows = selection.rows;
    selectionRows = rows;
    selectionPaths = extractPaths(rows);
    const path = selectionPaths.flatMap((item) => item.points);
    snapshot = buildSnapshot(rows);
    fitPoints = [
      ...path,
      ...snapshot.objects.dots.map((dot) => [dot.lat, dot.lon]),
    ];
    errorNote.classList.add("hidden");
    objectsEmpty.classList.add("hidden");
    clearLegend();
    syncLabelViewToggle();

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
      drawMap(L, canvas, selectionPaths, snapshot, syncLayers);
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

  async function redrawForLabelView() {
    if (!selectionRows.length || canvas.classList.contains("hidden")) {
      return;
    }
    const generation = ++openGeneration;
    snapshot = buildSnapshot(selectionRows);
    syncLabelViewToggle();
    try {
      const L = await loadLeaflet();
      if (generation !== openGeneration || !L) {
        return;
      }
      drawMap(L, canvas, selectionPaths, snapshot, syncLayers);
      fit();
    } catch (error) {
      console.error("[MAP] map failed:", error);
    }
  }

  labelViewToggle?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-label-view]");
    if (!button || button.dataset.labelView === labelView) {
      return;
    }
    labelView = button.dataset.labelView;
    redrawForLabelView();
  });

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

  return { open, close, resize };
}
