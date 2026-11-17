// Live co-annotation: persistent AI-label feed + Add / Replace / Delete.
import {
  haversineMeters,
  logUserAnnotation,
  onLiveDetectionLogCleared,
} from "../live/detection-log.js";
import { showCameraFeedback } from "../utils/camera.js";

const STABILITY_WINDOW = 6;
const STABILITY_MIN = 3;
const RENDER_INTERVAL_MS = 2000;
const PLACE_SPLIT_M = 15;
const FADE_DISTANCE_M = 15;

function formatAgo(timestamp, now = Date.now()) {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 60) {
    return `${seconds} s ago`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  const hours = Math.round(minutes / 60);
  return `${hours} h ago`;
}

function formatMetersBack(meters) {
  if (!Number.isFinite(meters)) {
    return null;
  }
  if (meters < 1000) {
    return `~${Math.round(meters)} m back`;
  }
  return `~${(meters / 1000).toFixed(1)} km back`;
}

export function initLiveAnnotate({ getGpsFix, getOrientation }) {
  const lists = [...document.querySelectorAll("[data-nearby-labels]")];
  const actionBars = [...document.querySelectorAll("[data-nearby-actions]")];
  const windows = [...document.querySelectorAll("[data-nearby-window]")];
  const holdInputs = [...document.querySelectorAll("[data-nearby-hold]")];
  const hints = [...document.querySelectorAll("[data-nearby-hint]")];
  const sheet = document.getElementById("annotate-sheet");
  const backdrop = document.getElementById("annotate-backdrop");
  const title = document.getElementById("annotate-sheet-title");
  const about = document.getElementById("annotate-sheet-about");
  const input = document.getElementById("annotate-input");
  const saveButton = document.getElementById("btn-annotate-save");
  const cancelButton = document.getElementById("btn-annotate-cancel");

  if (!lists.length || !actionBars.length || !sheet || !input || !saveButton || !cancelButton) {
    return {
      refresh() {},
      recordAnalysis() {},
      selectLabel() {},
      clearSelection() {},
      setLiveReady() {},
      clearFeed() {},
    };
  }

  let selectedLabel = null;
  let selectedRefersToRow = null;
  let sheetMode = "add";
  let holdEnabled = false;
  let pointerOver = false;
  let lastRenderAt = 0;
  let pendingRender = false;
  let renderTimerId = null;
  let liveRunning = false;
  let hasGpsFix = false;
  const analysisHistory = [];
  // Newest-first session feed; items are never removed until Clear recordings.
  const feed = [];

  function syncHoldInputs() {
    for (const hold of holdInputs) {
      hold.checked = holdEnabled;
    }
  }

  function isReorderFrozen() {
    return holdEnabled || Boolean(selectedLabel) || pointerOver;
  }

  function annotationReady() {
    return liveRunning && hasGpsFix;
  }

  function getStableLabels(now = Date.now()) {
    const recent = analysisHistory.slice(-STABILITY_WINDOW);
    const counts = new Map();
    const lastTs = new Map();
    for (const frame of recent) {
      for (const label of frame.labels) {
        counts.set(label, (counts.get(label) ?? 0) + 1);
        lastTs.set(label, Math.max(lastTs.get(label) ?? 0, frame.timestamp));
      }
    }
    return [...counts.entries()]
      .filter(([, count]) => count >= STABILITY_MIN)
      .map(([label]) => ({
        label,
        lastTimestamp: lastTs.get(label) ?? now,
      }));
  }

  function distanceFromCurrent(item, gpsFix) {
    if (
      gpsFix?.lat == null ||
      gpsFix?.lon == null ||
      item.lat == null ||
      item.lon == null
    ) {
      return null;
    }
    return haversineMeters(gpsFix, { lat: item.lat, lon: item.lon });
  }

  function ingestStableIntoFeed(now = Date.now()) {
    const gpsFix = getGpsFix?.() ?? null;
    const stable = getStableLabels(now);
    const freezeOrder = isReorderFrozen();

    for (const item of stable) {
      const existing = feed.find((entry) => entry.label === item.label);
      if (existing) {
        existing.lastTimestamp = item.lastTimestamp;
        if (now - (existing.lastCountAt ?? 0) >= 1000) {
          existing.count += 1;
          existing.lastCountAt = now;
        }
        if (gpsFix?.lat != null && gpsFix?.lon != null) {
          existing.lat = gpsFix.lat;
          existing.lon = gpsFix.lon;
        }
        if (!freezeOrder) {
          const index = feed.indexOf(existing);
          if (index > 0) {
            feed.splice(index, 1);
            feed.unshift(existing);
          }
        }
        continue;
      }
      const entry = {
        label: item.label,
        count: 1,
        lastCountAt: now,
        lastTimestamp: item.lastTimestamp,
        lat: gpsFix?.lat ?? null,
        lon: gpsFix?.lon ?? null,
        refersToRow: null,
      };
      if (freezeOrder) {
        feed.push(entry);
      } else {
        feed.unshift(entry);
      }
    }
  }

  function syncActionBars() {
    const ready = annotationReady();
    const hasSelection = Boolean(selectedLabel);
    for (const bar of actionBars) {
      for (const button of bar.querySelectorAll("[data-annotate-action]")) {
        const action = button.dataset.annotateAction;
        if (action === "deselect") {
          button.hidden = !hasSelection;
          button.setAttribute("aria-disabled", String(!hasSelection));
          button.classList.toggle("is-disabled", !hasSelection);
          continue;
        }
        button.hidden = false;
        if (action === "add") {
          button.textContent = hasSelection
            ? `Add to ${selectedLabel}`
            : "+ Add";
          button.setAttribute("aria-disabled", String(!ready));
          button.classList.toggle("is-disabled", !ready);
          if (ready) {
            button.removeAttribute("title");
          } else {
            button.title = liveRunning
              ? "Waiting for GPS…"
              : "Start live detection to annotate";
          }
          continue;
        }
        if (action === "replace" || action === "delete") {
          const disabled = !ready || !hasSelection;
          button.setAttribute("aria-disabled", String(disabled));
          button.classList.toggle("is-disabled", disabled);
          if (!ready) {
            button.title = liveRunning
              ? "Waiting for GPS…"
              : "Start live detection to annotate";
          } else if (!hasSelection) {
            button.title = "Select a label first";
          } else {
            button.removeAttribute("title");
          }
        }
      }
    }
    const hintText = !liveRunning
      ? "Start live detection to annotate"
      : !hasGpsFix
        ? "Waiting for GPS…"
        : "";
    for (const hint of hints) {
      hint.textContent = hintText;
      hint.hidden = !hintText;
    }
  }

  function buildFeedChildren(now = Date.now()) {
    const gpsFix = getGpsFix?.() ?? null;
    const nodes = [];

    if (!feed.length) {
      const empty = document.createElement("li");
      empty.className = "nearby-labels__empty";
      empty.textContent = "No AI labels yet";
      nodes.push(empty);
      return nodes;
    }

    let previous = null;
    for (const item of feed) {
      if (
        previous &&
        previous.lat != null &&
        previous.lon != null &&
        item.lat != null &&
        item.lon != null
      ) {
        const gap = haversineMeters(
          { lat: previous.lat, lon: previous.lon },
          { lat: item.lat, lon: item.lon },
        );
        if (gap > PLACE_SPLIT_M) {
          const fromHere = distanceFromCurrent(item, gpsFix);
          const divider = document.createElement("li");
          divider.className = "nearby-labels__divider";
          divider.textContent = `Earlier · ${formatMetersBack(fromHere ?? gap)}`;
          nodes.push(divider);
        }
      }

      const dist = distanceFromCurrent(item, gpsFix);
      const li = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "nearby-labels__item";
      button.dataset.label = item.label;
      button.classList.toggle(
        "nearby-labels__item--selected",
        selectedLabel === item.label,
      );
      button.classList.toggle(
        "nearby-labels__item--faded",
        dist != null && dist > FADE_DISTANCE_M,
      );
      button.setAttribute("aria-pressed", String(selectedLabel === item.label));
      button.textContent = `${item.label} ×${item.count} · ${formatAgo(item.lastTimestamp, now)}`;
      button.addEventListener("click", () => {
        selectLabel(item.label, item.refersToRow);
      });
      li.appendChild(button);
      nodes.push(li);
      previous = item;
    }
    return nodes;
  }

  function renderFeedRows(now = Date.now()) {
    for (const list of lists) {
      list.replaceChildren(...buildFeedChildren(now));
    }
    syncActionBars();
    syncHoldInputs();
    lastRenderAt = now;
    pendingRender = false;
  }

  function canRenderNow(now = Date.now()) {
    if (isReorderFrozen()) {
      // Still allow in-place updates (count / ago / fade) while frozen, but throttle.
      return now - lastRenderAt >= RENDER_INTERVAL_MS;
    }
    return now - lastRenderAt >= RENDER_INTERVAL_MS;
  }

  function scheduleRender({ force = false, ingest = false } = {}) {
    const now = Date.now();
    if (ingest) {
      ingestStableIntoFeed(now);
    }
    if (force) {
      if (renderTimerId != null) {
        clearTimeout(renderTimerId);
        renderTimerId = null;
      }
      renderFeedRows(now);
      return;
    }
    if (canRenderNow(now)) {
      if (renderTimerId != null) {
        clearTimeout(renderTimerId);
        renderTimerId = null;
      }
      renderFeedRows(now);
      return;
    }
    pendingRender = true;
    if (renderTimerId == null) {
      const wait = Math.max(0, RENDER_INTERVAL_MS - (now - lastRenderAt));
      renderTimerId = window.setTimeout(() => {
        renderTimerId = null;
        if (pendingRender && canRenderNow()) {
          renderFeedRows();
        }
      }, wait);
    }
  }

  function clearSelection() {
    selectedLabel = null;
    selectedRefersToRow = null;
    syncActionBars();
    scheduleRender({ force: true });
  }

  function selectLabel(label, refersToRow = null) {
    const trimmed = String(label ?? "").trim();
    if (!trimmed) {
      return;
    }
    if (selectedLabel === trimmed) {
      clearSelection();
      return;
    }
    selectedLabel = trimmed;
    const existing = feed.find((entry) => entry.label === trimmed);
    selectedRefersToRow = refersToRow ?? existing?.refersToRow ?? null;
    if (!existing) {
      const gpsFix = getGpsFix?.() ?? null;
      feed.unshift({
        label: trimmed,
        count: 1,
        lastTimestamp: Date.now(),
        lat: gpsFix?.lat ?? null,
        lon: gpsFix?.lon ?? null,
        refersToRow: selectedRefersToRow,
      });
    }
    renderFeedRows();
  }

  function recordAnalysis(labels, timestamp = Date.now()) {
    const unique = [
      ...new Set(
        (labels ?? [])
          .map((label) => String(label ?? "").trim())
          .filter(Boolean),
      ),
    ];
    analysisHistory.push({ timestamp, labels: unique });
    if (analysisHistory.length > STABILITY_WINDOW) {
      analysisHistory.shift();
    }
    scheduleRender({ ingest: true });
  }

  function clearFeed() {
    feed.length = 0;
    analysisHistory.length = 0;
    selectedLabel = null;
    selectedRefersToRow = null;
    scheduleRender({ force: true });
  }

  function setLiveReady({ running = false, hasGps = false } = {}) {
    liveRunning = Boolean(running);
    hasGpsFix = Boolean(hasGps);
    if (!liveRunning) {
      selectedLabel = null;
      selectedRefersToRow = null;
    }
    syncActionBars();
    scheduleRender({ force: true });
  }

  function closeSheet({ releaseSelection = false } = {}) {
    sheet.hidden = true;
    if (backdrop) {
      backdrop.hidden = true;
    }
    input.value = "";
    sheetMode = "add";
    if (releaseSelection) {
      clearSelection();
    }
  }

  function openSheet(mode = "add") {
    if (!annotationReady()) {
      return;
    }
    sheetMode = mode;
    if (mode === "replace") {
      if (!selectedLabel) {
        return;
      }
      if (title) {
        title.textContent = `Replace ${selectedLabel} with…`;
      }
      if (about) {
        about.hidden = true;
        about.textContent = "";
      }
      input.value = "";
      input.placeholder = `Replace ${selectedLabel} with…`;
    } else {
      if (title) {
        title.textContent = selectedLabel
          ? `About: ${selectedLabel}`
          : "New label";
      }
      if (about) {
        about.hidden = true;
        about.textContent = "";
      }
      input.value = "";
      input.placeholder = "Type or dictate…";
    }
    sheet.hidden = false;
    if (backdrop) {
      backdrop.hidden = false;
    }
    input.focus();
  }

  function logAction(action, text = null) {
    const nearbyLabels = feed.map((item) => item.label);
    return logUserAnnotation({
      text,
      action,
      gpsFix: getGpsFix?.() ?? null,
      orientation: getOrientation?.() ?? null,
      refersToLabel: selectedLabel,
      refersToRow: selectedRefersToRow,
      nearbyAiLabels: nearbyLabels,
    });
  }

  function save() {
    const text = input.value.trim();
    if (!text) {
      input.focus();
      return;
    }
    const action = sheetMode === "replace" ? "replace" : "add";
    if (action === "replace" && !selectedLabel) {
      return;
    }
    logAction(action, text);
    closeSheet({ releaseSelection: true });
    showCameraFeedback(action === "replace" ? "Replaced" : "Added");
  }

  function deleteSelected() {
    if (!selectedLabel || !annotationReady()) {
      return;
    }
    logAction("delete");
    clearSelection();
    showCameraFeedback("Deleted");
  }

  for (const bar of actionBars) {
    bar.addEventListener("click", (event) => {
      const button = event.target.closest("[data-annotate-action]");
      if (!button || button.getAttribute("aria-disabled") === "true") {
        return;
      }
      const action = button.dataset.annotateAction;
      if (action === "add") {
        openSheet("add");
      } else if (action === "replace") {
        openSheet("replace");
      } else if (action === "delete") {
        deleteSelected();
      } else if (action === "deselect") {
        clearSelection();
      }
    });
  }

  for (const hold of holdInputs) {
    hold.addEventListener("change", () => {
      holdEnabled = hold.checked;
      syncHoldInputs();
      if (!isReorderFrozen()) {
        scheduleRender({ force: true, ingest: true });
      }
    });
  }

  for (const win of windows) {
    win.addEventListener("pointerenter", () => {
      pointerOver = true;
    });
    win.addEventListener("pointerleave", () => {
      pointerOver = false;
      if (pendingRender) {
        scheduleRender({ force: true });
      }
    });
  }

  cancelButton.addEventListener("click", () => {
    closeSheet({ releaseSelection: true });
  });
  saveButton.addEventListener("click", save);
  backdrop?.addEventListener("click", () => {
    closeSheet({ releaseSelection: true });
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      save();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !sheet.hidden) {
      closeSheet({ releaseSelection: true });
    }
  });

  onLiveDetectionLogCleared(clearFeed);
  scheduleRender({ force: true });
  syncActionBars();

  return {
    refresh: () => scheduleRender({ force: true }),
    recordAnalysis,
    selectLabel,
    clearSelection,
    setLiveReady,
    clearFeed,
  };
}
