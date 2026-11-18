// Live-mode co-annotation: label list, FAB add sheet, row actions, undo toast.
import {
  findLatestAiRowForLabel,
  logUserAction,
  onLiveDetectionLogCleared,
  removeUserLogRow,
} from "../live/detection-log.js";
import { getModelId } from "../models.js";

const TOAST_MS = 3200;
const IN_VIEW_LINGER_MS = 3000;

function formatAgo(ms, now) {
  const seconds = Math.max(0, Math.round((now - ms) / 1000));
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  const hours = Math.round(minutes / 60);
  return `${hours} hr ago`;
}

function formatCoords(gpsFix) {
  if (gpsFix?.lat == null || gpsFix?.lon == null) {
    return "Location unavailable";
  }
  return `${gpsFix.lat.toFixed(5)}, ${gpsFix.lon.toFixed(5)}`;
}

export function initLiveAnnotate() {
  const desktopHost = document.getElementById("ai-labels-desktop-host");
  const phoneHost = document.getElementById("ai-labels-phone-host");
  const fab = document.getElementById("btn-add-label");
  if (!desktopHost || !phoneHost) {
    return null;
  }

  const panel = document.createElement("section");
  panel.className = "live-card ai-labels";
  panel.innerHTML = `
    <div class="list-head">
      <h4>Labels <span class="muted" data-annotate-count style="font-weight:500">· 0</span></h4>
      <button type="button" class="btn btn--secondary desktop-only" data-annotate-add-desktop>Add label</button>
    </div>
    <p class="ai-labels__hint" data-annotate-hint></p>
    <div class="ai-labels__scroll" data-annotate-scroll>
      <div class="ai-labels__section" data-in-view-section hidden>
        <div class="ai-labels__section-h">In view now</div>
        <ul class="ai-labels__list" data-annotate-in-view aria-label="In view now"></ul>
      </div>
      <div class="ai-labels__section" data-earlier-section hidden>
        <div class="ai-labels__section-h">Earlier</div>
        <ul class="ai-labels__list" data-annotate-earlier aria-label="Earlier labels"></ul>
      </div>
      <ul class="ai-labels__list" data-annotate-list aria-label="Labels" hidden></ul>
    </div>
  `;

  const listEl = panel.querySelector("[data-annotate-list]");
  const inViewSection = panel.querySelector("[data-in-view-section]");
  const earlierSection = panel.querySelector("[data-earlier-section]");
  const inViewListEl = panel.querySelector("[data-annotate-in-view]");
  const earlierListEl = panel.querySelector("[data-annotate-earlier]");
  const hintEl = panel.querySelector("[data-annotate-hint]");
  const countEl = panel.querySelector("[data-annotate-count]");
  const desktopAddBtn = panel.querySelector("[data-annotate-add-desktop]");

  function placePanel() {
    const phone = window.matchMedia("(max-width: 767px)").matches;
    panel.classList.toggle("card", phone);
    panel.classList.toggle("live-card", !phone);
    (phone ? phoneHost : desktopHost).appendChild(panel);
  }

  placePanel();
  window.addEventListener("resize", placePanel);

  const sheet = document.createElement("div");
  sheet.className = "sheet annotate-sheet";
  sheet.hidden = true;
  sheet.setAttribute("role", "dialog");
  sheet.setAttribute("aria-modal", "true");
  sheet.innerHTML = `
    <div class="grab" aria-hidden="true"></div>
    <div class="sheet-head">
      <div>
        <h2 data-sheet-title>New label</h2>
        <small data-sheet-sub></small>
      </div>
      <button type="button" class="x" data-annotate-cancel aria-label="Close">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>
    </div>
    <div class="sheet-body">
      <div class="frame" data-frame>
        <div class="thumb nof" data-thumb></div>
        <div>
          <b data-frame-title>No frame attached</b>
          <small data-frame-meta>Saved with your location only. Start detection to attach a frame.</small>
        </div>
      </div>
      <span class="eyebrow" data-chips-label>Recent labels</span>
      <div class="chips" data-chips></div>
      <label class="field">
        <span class="eyebrow">Or type a label</span>
        <input class="input" id="annotate-input" type="text" autocomplete="off" enterkeyhint="done" data-annotate-input placeholder="e.g. trench coat">
      </label>
      <button type="button" class="btn btn-primary" data-annotate-save>Save label</button>
    </div>
  `;
  const scrim = document.createElement("div");
  scrim.className = "scrim";
  scrim.hidden = true;

  const toast = document.createElement("div");
  toast.className = "annotate-toast";
  toast.hidden = true;
  toast.setAttribute("role", "status");
  toast.innerHTML = `
    <span data-toast-text>Deleted</span>
    <button type="button" class="annotate-toast__undo" data-toast-undo>Undo</button>
  `;

  document.body.append(scrim, sheet, toast);

  const titleEl = sheet.querySelector("[data-sheet-title]");
  const subEl = sheet.querySelector("[data-sheet-sub]");
  const thumbEl = sheet.querySelector("[data-thumb]");
  const frameTitle = sheet.querySelector("[data-frame-title]");
  const frameMeta = sheet.querySelector("[data-frame-meta]");
  const chipsLabel = sheet.querySelector("[data-chips-label]");
  const chipsEl = sheet.querySelector("[data-chips]");
  const input = sheet.querySelector("[data-annotate-input]");
  const cancelBtn = sheet.querySelector("[data-annotate-cancel]");
  const saveBtn = sheet.querySelector("[data-annotate-save]");
  const toastText = toast.querySelector("[data-toast-text]");
  const toastUndo = toast.querySelector("[data-toast-undo]");

  const byLabel = new Map();
  const order = [];
  /** @type {Map<string, { label: string, score: number|null, box: object|null, lastSeen: number, rowId: number|null }>} */
  const inView = new Map();
  let selectedLabel = null;
  let running = false;
  let frozen = false;
  let gpsFix = null;
  let orientation = null;
  let backend = null;
  let suggestions = [];
  let captureFrame = null;
  let sheetOpen = false;
  let sheetMode = "add"; // add | replace
  let pick = null;
  let toastTimer = null;
  let toastRowId = null;
  let undoFn = null;
  /** @type {null | { label: string, box: object, box2d: number[], frameW: number, frameH: number, timestamp: number, prompt: string|null, gpsFix: object|null }} */
  let frozenSelection = null;
  /** Live box-tap snapshot (video keeps running). */
  let liveSnapshot = null;
  let onSelectionChange = null;

  function canAnnotateLive() {
    return running || frozen;
  }

  function activeSnapshot(label) {
    if (
      frozen &&
      frozenSelection &&
      frozenSelection.label === label
    ) {
      return frozenSelection;
    }
    if (liveSnapshot && liveSnapshot.label === label) {
      return liveSnapshot;
    }
    return null;
  }

  function selectionMeta(label) {
    const snap = activeSnapshot(label);
    if (!snap?.box) {
      return {};
    }
    return {
      box: snap.box,
      box2d: snap.box2d,
      frameW: snap.frameW,
      frameH: snap.frameH,
      timestamp: snap.timestamp,
      prompt: snap.prompt,
    };
  }

  function actionGpsFix(label) {
    return activeSnapshot(label)?.gpsFix ?? gpsFix;
  }

  function setFabHidden(hidden) {
    fab?.classList.toggle("is-hidden", hidden);
  }

  function openAddFlow() {
    selectedLabel = null;
    openSheet("add");
  }

  function syncHint() {
    hintEl.textContent = canAnnotateLive()
      ? frozen
        ? "Frozen Look — tap a box or label to Add / Replace / Delete."
        : "Tap a box or label to Add / Replace / Delete."
      : "Detection is off, so labels you add now are saved without a frame.";
    hintEl.hidden = !hintEl.textContent;
    countEl.textContent = `· ${order.length}`;
    const labelCount = document.querySelector('[data-metric="label-count"]');
    if (labelCount) {
      labelCount.textContent = String(order.length);
    }
  }

  function pruneInView(now = Date.now()) {
    for (const [label, entry] of inView) {
      if (now - entry.lastSeen > IN_VIEW_LINGER_MS) {
        inView.delete(label);
      }
    }
  }

  function inViewEntries(now = Date.now()) {
    pruneInView(now);
    return [...inView.values()].sort((a, b) => b.lastSeen - a.lastSeen);
  }

  function earlierEntries(now = Date.now()) {
    const active = new Set(inViewEntries(now).map((entry) => entry.label));
    return order
      .filter((entry) => !active.has(entry.label))
      .slice()
      .sort((a, b) => b.lastSeen - a.lastSeen);
  }

  function resolveRef(label) {
    const entry = byLabel.get(label);
    const refersToRow =
      entry?.latestRowId ?? findLatestAiRowForLabel(label)?.id ?? null;
    return { refersToLabel: label, refersToRow };
  }

  function renderChips() {
    chipsEl.replaceChildren();
    const items = canAnnotateLive()
      ? suggestions.slice(0, 5).map((item) => [item.label, item.score])
      : order.slice(0, 4).map((entry) => [entry.label, null]);

    chipsLabel.textContent = canAnnotateLive()
      ? "Model suggestions"
      : "Recent labels";

    for (const [name, score] of items) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip";
      chip.dataset.pick = name;
      chip.setAttribute("aria-pressed", String(pick === name));
      chip.innerHTML =
        score == null
          ? name
          : `${name}<em class="mono">${Math.round(score * 100)}%</em>`;
      chipsEl.appendChild(chip);
    }
  }

  function syncFramePreview() {
    const dataUrl =
      canAnnotateLive() && typeof captureFrame === "function"
        ? captureFrame()
        : null;
    thumbEl.classList.toggle("nof", !dataUrl);
    thumbEl.replaceChildren();
    if (dataUrl) {
      const img = document.createElement("img");
      img.src = dataUrl;
      img.alt = "";
      thumbEl.appendChild(img);
      frameTitle.textContent = "Current frame";
      frameMeta.textContent = `${formatCoords(gpsFix)} · just now`;
      frameMeta.classList.add("mono");
    } else {
      frameTitle.textContent = "No frame attached";
      frameMeta.textContent =
        "Saved with your location only. Start detection to attach a frame.";
      frameMeta.classList.remove("mono");
    }
  }

  function openSheet(mode = "add") {
    sheetMode = mode;
    pick = null;
    const replacing = mode === "replace" ? selectedLabel : null;
    titleEl.textContent = replacing ? "Replace label" : "New label";
    subEl.textContent = replacing
      ? `Replacing “${replacing}”`
      : running
        ? "Tag what’s in the current frame"
        : "Log something you’ve seen";
    saveBtn.textContent = replacing ? "Replace label" : "Save label";
    input.value = replacing ?? "";
    syncFramePreview();
    renderChips();
    sheet.hidden = false;
    scrim.hidden = false;
    sheet.classList.add("is-mounted");
    scrim.classList.add("is-mounted");
    sheetOpen = true;
    setFabHidden(true);
    hideToast(false);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        sheet.classList.add("open");
        scrim.classList.add("on");
      });
    });
    input.focus();
    if (replacing) {
      input.select();
    }
  }

  function closeSheet() {
    sheet.classList.remove("open");
    scrim.classList.remove("on");
    sheetOpen = false;
    pick = null;
    const finish = () => {
      if (!sheetOpen) {
        sheet.classList.remove("is-mounted");
        scrim.classList.remove("is-mounted");
        sheet.hidden = true;
        scrim.hidden = true;
      }
    };
    sheet.addEventListener("transitionend", finish, { once: true });
    window.setTimeout(finish, 360);
    if (!toastTimer) {
      setFabHidden(false);
    }
  }

  function hideToast(showFab = true) {
    if (toastTimer != null) {
      clearTimeout(toastTimer);
      toastTimer = null;
    }
    toastRowId = null;
    undoFn = null;
    toast.classList.remove("on");
    window.setTimeout(() => {
      if (!toast.classList.contains("on")) {
        toast.classList.remove("is-mounted");
        toast.hidden = true;
      }
    }, 220);
    if (showFab && !sheetOpen) {
      setFabHidden(false);
    }
  }

  function showToast(message, undo = null) {
    hideToast(false);
    toastRowId = null;
    undoFn = undo;
    toastText.textContent = message;
    toastUndo.hidden = !undo;
    toast.hidden = false;
    toast.classList.add("is-mounted");
    setFabHidden(true);
    requestAnimationFrame(() => toast.classList.add("on"));
    toastTimer = setTimeout(() => hideToast(true), TOAST_MS);
  }

  function createLabelItem(entry, now) {
    const item = document.createElement("li");
    item.className = "ai-labels__item";
    item.dataset.label = entry.label;
    item.setAttribute("role", "button");
    item.tabIndex = 0;
    item.setAttribute("aria-expanded", "false");
    updateLabelItem(item, entry, now);
    return item;
  }

  function updateLabelItem(item, entry, now, { inViewNow = false } = {}) {
    const selected = entry.label === selectedLabel;
    item.classList.toggle("ai-labels__item--selected", selected);
    item.classList.toggle("ai-labels__item--in-view", inViewNow);
    item.setAttribute("aria-expanded", String(selected));

    item.replaceChildren();
    const r1 = document.createElement("div");
    r1.className = "r1";
    const name = document.createElement("span");
    name.className = "ai-labels__name";
    name.textContent = entry.label;
    const count = document.createElement("span");
    count.className = "ai-labels__count mono";
    count.dataset.count = entry.label;
    const history = byLabel.get(entry.label);
    count.textContent = String(history?.count ?? entry.count ?? 1);
    r1.append(name, count);

    const meta = document.createElement("div");
    meta.className = "ai-labels__meta";
    if (inViewNow) {
      const age = Math.max(0, now - entry.lastSeen);
      meta.textContent =
        age < 800 ? "Now" : `In view · ${formatAgo(entry.lastSeen, now)}`;
    } else {
      meta.textContent = `Last seen ${formatAgo(entry.lastSeen, now)}`;
    }

    item.append(r1, meta);

    if (!selected) {
      return;
    }

    const actions = document.createElement("div");
    actions.className = "ai-labels__actions";
    const live = canAnnotateLive();
    actions.innerHTML = `
      <button type="button" class="a" data-act="addto" ${live ? "" : "disabled"} aria-label="Add current frame to ${entry.label}">Add to</button>
      <button type="button" class="a" data-act="replace" ${live ? "" : "disabled"} aria-label="Replace ${entry.label}">Replace</button>
      <button type="button" class="a del" data-act="del" aria-label="Delete ${entry.label}">Delete</button>
    `;
    item.append(actions);
    if (!live) {
      const note = document.createElement("p");
      note.className = "ai-labels__actions-note";
      note.textContent =
        "Add to and Replace use the live frame. Start detection to use them.";
      item.append(note);
    }
  }

  function fillList(list, entries, now, inViewNow) {
    const nodes = [...list.querySelectorAll("[data-label]")];
    const byNode = new Map(nodes.map((node) => [node.dataset.label, node]));
    list.replaceChildren(
      ...entries.map((entry) => {
        const existing = byNode.get(entry.label);
        if (existing) {
          updateLabelItem(existing, entry, now, { inViewNow });
          return existing;
        }
        const item = createLabelItem(entry, now);
        updateLabelItem(item, entry, now, { inViewNow });
        return item;
      }),
    );
  }

  function renderList(now = Date.now()) {
    const current = inViewEntries(now);
    const earlier = earlierEntries(now);
    const split = current.length > 0 || earlier.length > 0;

    if (split) {
      listEl.hidden = true;
      inViewSection.hidden = current.length === 0;
      earlierSection.hidden = earlier.length === 0;
      if (current.length) {
        fillList(inViewListEl, current, now, true);
      } else {
        inViewListEl.replaceChildren();
      }
      if (earlier.length) {
        fillList(earlierListEl, earlier, now, false);
      } else {
        earlierListEl.replaceChildren();
      }
    } else {
      inViewSection.hidden = true;
      earlierSection.hidden = true;
      inViewListEl.replaceChildren();
      earlierListEl.replaceChildren();
      listEl.hidden = false;
      fillList(listEl, order.slice().sort((a, b) => b.lastSeen - a.lastSeen), now, false);
    }
    syncHint();
  }

  function bumpCount(label) {
    const count = listEl.querySelector(`[data-count="${CSS.escape(label)}"]`);
    if (!count) {
      return;
    }
    count.classList.add("bump");
    window.setTimeout(() => count.classList.remove("bump"), 200);
  }

  function commitAction(kind, labelText) {
    const selected = selectedLabel;

    if (kind === "addto") {
      if (!canAnnotateLive() || !selected) {
        return;
      }
      const { refersToLabel, refersToRow } = resolveRef(selected);
      logUserAction({
        action: "add",
        label: selected,
        refersToLabel,
        refersToRow,
        gpsFix: actionGpsFix(selected),
        orientation,
        modelId: getModelId(),
        backend,
        ...selectionMeta(selected),
      });
      const entry = byLabel.get(selected);
      if (entry) {
        entry.count += 1;
        entry.lastSeen = Date.now();
      }
      renderList();
      bumpCount(selected);
      showToast(`Added frame to ${selected}`);
      return;
    }

    if (kind === "delete") {
      if (!selected) {
        return;
      }
      const { refersToLabel, refersToRow } = resolveRef(selected);
      const removed = byLabel.get(selected);
      const index = order.findIndex((entry) => entry.label === selected);
      const row = logUserAction({
        action: "delete",
        label: "",
        refersToLabel,
        refersToRow,
        gpsFix: actionGpsFix(selected),
        orientation,
        modelId: getModelId(),
        backend,
        ...selectionMeta(selected),
      });
      if (removed && index >= 0) {
        order.splice(index, 1);
        byLabel.delete(selected);
      }
      inView.delete(selected);
      selectedLabel = null;
      liveSnapshot = null;
      if (frozen && frozenSelection) {
        frozenSelection = { ...frozenSelection, label: null };
      }
      onSelectionChange?.(null);
      renderList();
      showToast(`Deleted “${removed?.label ?? refersToLabel}”`, () => {
        if (row?.id != null) {
          removeUserLogRow(row.id);
        }
        if (removed && index >= 0) {
          byLabel.set(removed.label, removed);
          order.splice(index, 0, removed);
          selectedLabel = removed.label;
          renderList();
        }
      });
      return;
    }

    if (kind === "replace") {
      if (!canAnnotateLive() || !selected) {
        return;
      }
      const { refersToLabel, refersToRow } = resolveRef(selected);
      logUserAction({
        action: "replace",
        label: labelText,
        refersToLabel,
        refersToRow,
        gpsFix: actionGpsFix(selected),
        orientation,
        modelId: getModelId(),
        backend,
        ...selectionMeta(selected),
      });
      const entry = byLabel.get(selected);
      if (entry) {
        byLabel.delete(selected);
        entry.label = labelText;
        entry.lastSeen = Date.now();
        byLabel.set(labelText, entry);
        selectedLabel = labelText;
        if (inView.has(selected)) {
          const view = inView.get(selected);
          inView.delete(selected);
          inView.set(labelText, { ...view, label: labelText });
        }
        if (liveSnapshot?.label === selected) {
          liveSnapshot = { ...liveSnapshot, label: labelText };
        }
        if (frozenSelection?.label === selected) {
          frozenSelection = { ...frozenSelection, label: labelText };
        }
        onSelectionChange?.(labelText);
      }
      closeSheet();
      renderList();
      showToast(`Replaced “${selected}” with “${labelText}”`);
      return;
    }

    // New label (FAB / idle or live)
    const row = logUserAction({
      action: "add",
      label: labelText,
      refersToLabel: null,
      refersToRow: null,
      gpsFix: actionGpsFix(selectedLabel),
      orientation,
      modelId: getModelId(),
      backend,
      ...selectionMeta(selectedLabel),
    });
    const existing = byLabel.get(labelText);
    if (existing) {
      existing.count += 1;
      existing.lastSeen = Date.now();
      if (row?.id != null) {
        existing.latestRowId = row.id;
      }
    } else {
      const entry = {
        label: labelText,
        count: 1,
        lastSeen: Date.now(),
        latestRowId: row?.id ?? null,
      };
      byLabel.set(labelText, entry);
      order.unshift(entry);
    }
    selectedLabel = null;
    closeSheet();
    renderList();
    bumpCount(labelText);
    showToast(`Saved “${labelText}”`);
  }

  function noteLiveLabels(items) {
    const now = Date.now();
    for (const item of items ?? []) {
      const label = String(item.label ?? "").trim();
      if (!label) {
        continue;
      }
      inView.set(label, {
        label,
        score: item.score ?? null,
        box: item.box ?? null,
        frameW: item.frameW ?? null,
        frameH: item.frameH ?? null,
        lastSeen: now,
        rowId: item.rowId ?? null,
        count: byLabel.get(label)?.count ?? 1,
      });

      let entry = byLabel.get(label);
      if (entry) {
        entry.count += 1;
        entry.lastSeen = now;
        if (item.rowId != null) {
          entry.latestRowId = item.rowId;
        }
      } else {
        entry = {
          label,
          count: 1,
          lastSeen: now,
          latestRowId: item.rowId ?? null,
        };
        byLabel.set(label, entry);
        order.unshift(entry);
      }
    }

    // Keep lingering in-view items that left this frame for IN_VIEW_LINGER_MS.
    pruneInView(now);
    if (
      selectedLabel &&
      liveSnapshot?.label === selectedLabel &&
      inView.has(selectedLabel) &&
      !liveSnapshot.locked
    ) {
      const view = inView.get(selectedLabel);
      liveSnapshot = {
        ...liveSnapshot,
        box: view.box ?? liveSnapshot.box,
      };
    }
    renderList(now);
  }

  function setSuggestions(next) {
    suggestions = Array.isArray(next) ? next : [];
    if (sheetOpen && running) {
      renderChips();
    }
  }

  function setLiveAnnotateState(next) {
    if ("running" in next) {
      running = Boolean(next.running);
    }
    if ("frozen" in next) {
      frozen = Boolean(next.frozen);
      if (!frozen) {
        frozenSelection = null;
      }
    }
    if ("frozenFrame" in next && next.frozenFrame) {
      frozenSelection = {
        ...(frozenSelection || {}),
        ...next.frozenFrame,
        detections: next.frozenFrame.detections ?? frozenSelection?.detections,
      };
    }
    if ("gpsFix" in next) {
      gpsFix = next.gpsFix;
    }
    if ("orientation" in next) {
      orientation = next.orientation;
    }
    if ("backend" in next) {
      backend = next.backend;
    }
    if ("captureFrame" in next) {
      captureFrame = next.captureFrame;
    }
    if ("onSelectionChange" in next) {
      onSelectionChange = next.onSelectionChange;
    }
    if (selectedLabel) {
      renderList();
    } else {
      syncHint();
    }
  }

  function resetLabels() {
    byLabel.clear();
    order.length = 0;
    inView.clear();
    selectedLabel = null;
    frozenSelection = null;
    liveSnapshot = null;
    suggestions = [];
    listEl.replaceChildren();
    inViewListEl.replaceChildren();
    earlierListEl.replaceChildren();
    hideToast(true);
    closeSheet();
    syncHint();
  }

  function showStatusToast(message) {
    showToast(message);
  }

  function handleListClick(event) {
    const act = event.target.closest("[data-act]");
    if (act) {
      event.preventDefault();
      event.stopPropagation();
      const action = act.dataset.act;
      if (action === "addto") {
        if (!canAnnotateLive() || act.disabled) {
          return;
        }
        commitAction("addto", selectedLabel);
        return;
      }
      if (action === "replace") {
        if (!canAnnotateLive() || act.disabled) {
          return;
        }
        openSheet("replace");
        return;
      }
      if (action === "del") {
        commitAction("delete", "");
        return;
      }
    }

    const item = event.target.closest("[data-label]");
    if (!item) {
      return;
    }
    const label = item.dataset.label;
    if (selectedLabel === label) {
      selectLabel(null);
      return;
    }
    const view = inView.get(label);
    selectLabel(
      label,
      view
        ? {
            box: view.box,
            frameW: view.frameW,
            frameH: view.frameH,
            timestamp: Date.now(),
            gpsFix,
            locked: true,
          }
        : { gpsFix, locked: true, timestamp: Date.now() },
    );
  }

  function selectLabel(label, meta = null) {
    selectedLabel = label || null;
    if (meta && selectedLabel) {
      const snap = {
        label: selectedLabel,
        box: meta.box ?? null,
        box2d: meta.box2d ?? null,
        frameW: meta.frameW ?? null,
        frameH: meta.frameH ?? null,
        timestamp: meta.timestamp ?? Date.now(),
        prompt: meta.prompt ?? null,
        gpsFix: meta.gpsFix ?? gpsFix,
        locked: meta.locked !== false,
      };
      if (frozen) {
        frozenSelection = { ...(frozenSelection || {}), ...snap };
      } else {
        liveSnapshot = snap;
      }
    } else if (!selectedLabel) {
      liveSnapshot = null;
      if (frozenSelection) {
        frozenSelection = { ...frozenSelection, label: null };
      }
    } else if (frozen && frozenSelection?.detections) {
      const hit = frozenSelection.detections.find(
        (item) => item.label === selectedLabel,
      );
      if (hit) {
        frozenSelection = {
          ...frozenSelection,
          label: selectedLabel,
          box: hit.box,
          box2d: hit.box2d,
        };
      }
    } else if (!frozen && inView.has(selectedLabel) && !liveSnapshot) {
      const view = inView.get(selectedLabel);
      liveSnapshot = {
        label: selectedLabel,
        box: view.box,
        box2d: null,
        frameW: view.frameW,
        frameH: view.frameH,
        timestamp: Date.now(),
        prompt: null,
        gpsFix,
        locked: true,
      };
    }
    onSelectionChange?.(selectedLabel);
    renderList();
  }

  for (const list of [listEl, inViewListEl, earlierListEl]) {
    list.addEventListener("click", handleListClick);
    list.addEventListener("keydown", (event) => {
      if (
        (event.key === "Enter" || event.key === " ") &&
        event.target.matches(".ai-labels__item")
      ) {
        event.preventDefault();
        event.target.click();
      }
    });
  }

  fab?.addEventListener("click", openAddFlow);
  desktopAddBtn?.addEventListener("click", openAddFlow);

  chipsEl.addEventListener("click", (event) => {
    const chip = event.target.closest("[data-pick]");
    if (!chip) {
      return;
    }
    pick = chip.dataset.pick;
    input.value = pick;
    for (const node of chipsEl.querySelectorAll(".chip")) {
      node.setAttribute("aria-pressed", String(node === chip));
    }
  });

  saveBtn.addEventListener("click", () => {
    const value = input.value.trim();
    if (!value) {
      input.focus();
      return;
    }
    if (sheetMode === "replace") {
      commitAction("replace", value);
    } else {
      selectedLabel = null;
      commitAction("add", value);
    }
  });

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      saveBtn.click();
    }
  });

  cancelBtn.addEventListener("click", closeSheet);
  scrim.addEventListener("click", closeSheet);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && sheetOpen) {
      closeSheet();
    }
  });

  toastUndo.addEventListener("click", () => {
    const fn = undoFn;
    undoFn = null;
    hideToast(true);
    fn?.();
  });

  syncHint();
  setInterval(() => {
    if (order.length || inView.size) {
      renderList();
    }
  }, 500);

  onLiveDetectionLogCleared(resetLabels);

  return {
    noteLiveLabels,
    setLiveAnnotateState,
    setSuggestions,
    selectLabel,
    showStatusToast,
    resetLabels,
    getLabelCount: () => order.length,
    getSelectedLabel: () => selectedLabel,
  };
}
