// Live (camera) and Review (Map and Summary tabs). Switching never touches the camera, model, sensors, or log.
import {
  getLiveDetectionLog,
  getRecordings,
  onLiveDetectionLogCleared,
  recordingDurationMs,
} from "../live/detection-log.js";
import { formatClockTime } from "../utils/time.js";

// null means "All recordings"; Export reads this.
let selectedRecording = null;

export function getSelectedRecordingId() {
  return selectedRecording;
}

function formatShortDuration(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 60 ? `${seconds} s` : `${Math.round(seconds / 60)} min`;
}

function recordingOptionLabel(recording, now) {
  const id = recording.recording_id;
  const name =
    recording.end_time == null
      ? `Recording ${id} (in progress)`
      : `Recording ${id}`;
  const rows = `${recording.row_count} ${recording.row_count === 1 ? "row" : "rows"}`;
  return [
    name,
    formatClockTime(recording.start_time),
    formatShortDuration(recordingDurationMs(recording, now)),
    rows,
  ].join(" · ");
}

export function initAppMode(views) {
  const modeButtons = [...document.querySelectorAll("[data-app-mode]")];
  const liveOnly = document.querySelectorAll('[data-show-in="live"]');
  const reviewOnly = document.querySelectorAll('[data-show-in="review"]');
  const reviewPanel = document.getElementById("review-panel");
  const reviewEmpty = document.getElementById("review-empty");
  const reviewBody = document.getElementById("review-body");
  const picker = document.getElementById("review-recording");
  const tablist = document.getElementById("review-tabs");
  const tabs = [...(tablist?.querySelectorAll('[role="tab"]') ?? [])];

  if (
    !modeButtons.length ||
    !reviewPanel ||
    !reviewEmpty ||
    !reviewBody ||
    !picker ||
    !tabs.length
  ) {
    return;
  }

  let mode = "live";
  let activeTab = "map";
  // Taken when entering Review; the picker filters it.
  let snapshot = null;
  let selection = null;
  // Tabs built since entering Review; the rest build from the log when first shown.
  const built = new Set();

  function setVisible(nodes, visible) {
    for (const node of nodes) {
      node.classList.toggle("hidden", !visible);
    }
  }

  function closeViews() {
    built.clear();
    views.map.close();
    views.summary.close();
  }

  function showTab(name) {
    activeTab = name;
    for (const tab of tabs) {
      const selected = tab.dataset.reviewTab === name;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
      document
        .getElementById(tab.getAttribute("aria-controls"))
        ?.classList.toggle("hidden", !selected);
    }
    if (built.has(name)) {
      views[name].resize();
    } else {
      built.add(name);
      views[name].open(selection);
    }
  }

  function showSelection() {
    closeViews();
    selectedRecording = picker.value === "all" ? null : Number(picker.value);
    const all = selectedRecording == null;
    selection = {
      all,
      takenAt: snapshot.takenAt,
      rows: all
        ? snapshot.rows
        : snapshot.rows.filter((row) => row.recording_id === selectedRecording),
      recordings: all
        ? snapshot.recordings
        : snapshot.recordings.filter(
            (item) => item.recording_id === selectedRecording,
          ),
    };
    showTab(activeTab);
  }

  function fillPicker() {
    const options = [new Option("All recordings", "all")];
    for (const recording of snapshot.recordings) {
      options.push(
        new Option(
          recordingOptionLabel(recording, snapshot.takenAt),
          String(recording.recording_id),
        ),
      );
    }
    picker.replaceChildren(...options);
    picker.value = String(snapshot.recordings.at(-1).recording_id);
  }

  function renderReview() {
    closeViews();
    snapshot = {
      takenAt: Date.now(),
      rows: getLiveDetectionLog().slice(),
      recordings: getRecordings().map((item) => ({ ...item })),
    };
    const hasRecordings = snapshot.recordings.length > 0;
    reviewEmpty.classList.toggle("hidden", hasRecordings);
    reviewBody.classList.toggle("hidden", !hasRecordings);
    if (!hasRecordings) {
      selectedRecording = null;
      picker.replaceChildren();
      return;
    }
    fillPicker();
    showSelection();
  }

  function setMode(next) {
    if (next === mode) {
      return;
    }
    mode = next;
    for (const button of modeButtons) {
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.appMode === mode),
      );
    }
    setVisible(liveOnly, mode === "live");
    setVisible(reviewOnly, mode === "review");
    reviewPanel.classList.toggle("hidden", mode !== "review");
    if (mode === "review") {
      renderReview();
    } else {
      closeViews();
    }
  }

  picker.addEventListener("change", showSelection);

  for (const button of modeButtons) {
    button.addEventListener("click", () => setMode(button.dataset.appMode));
  }

  for (const tab of tabs) {
    tab.addEventListener("click", () => {
      if (tab.dataset.reviewTab !== activeTab) {
        showTab(tab.dataset.reviewTab);
      }
    });
  }

  tablist.addEventListener("keydown", (event) => {
    const index = tabs.indexOf(document.activeElement);
    const targets = {
      ArrowLeft: index - 1,
      ArrowRight: index + 1,
      Home: 0,
      End: tabs.length - 1,
    };
    if (index === -1 || !(event.key in targets)) {
      return;
    }
    event.preventDefault();
    const next = tabs[(targets[event.key] + tabs.length) % tabs.length];
    next.focus();
    showTab(next.dataset.reviewTab);
  });

  onLiveDetectionLogCleared(() => {
    if (mode === "review") {
      renderReview();
    }
  });
}
