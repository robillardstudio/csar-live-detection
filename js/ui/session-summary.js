// On-demand snapshot of the in-memory detection log. Does not record, detect, or export.
import {
  getRecordingById,
  onRecordingUpdated,
  recordingDurationMs,
  trackDistanceMeters,
} from "../live/detection-log.js";
import { formatClockTime } from "../utils/time.js";
import { playRecordingAudio } from "./app-mode.js";
import { retryMomentAnnotation } from "../live/moment-annotate.js";
import { hasGeminiApiKey } from "../live/gemini-settings.js";

const CHART_SRC =
  "https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js";
const TOP_LABELS = 8;

let chart = null;
let chartLoader = null;
let openGeneration = 0;

function loadChartJs() {
  if (window.Chart) {
    return Promise.resolve(window.Chart);
  }
  if (!chartLoader) {
    chartLoader = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = CHART_SRC;
      script.async = true;
      script.onload = () => resolve(window.Chart);
      script.onerror = () => {
        chartLoader = null;
        reject(new Error("Chart.js failed to load"));
      };
      document.head.appendChild(script);
    });
  }
  return chartLoader;
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(Number(ms) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function joinList(items) {
  if (items.length <= 1) {
    return items[0] ?? "an unspecified model";
  }
  if (items.length === 2) {
    return `${items[0]} and ${items[1]}`;
  }
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

function countLabel(count, singular, plural) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function summarizeDetectionLog(rows) {
  const timestamps = new Set();
  const models = [];
  const seenModels = new Set();
  const labelCounts = new Map();
  let confidenceSum = 0;
  let confidenceCount = 0;
  let firstTimestamp = null;
  let lastTimestamp = null;

  for (const row of rows) {
    const timestamp = Number(row.timestamp);
    if (Number.isFinite(timestamp)) {
      timestamps.add(timestamp);
      if (firstTimestamp === null || timestamp < firstTimestamp) {
        firstTimestamp = timestamp;
      }
      if (lastTimestamp === null || timestamp > lastTimestamp) {
        lastTimestamp = timestamp;
      }
    }

    if (row.model && !seenModels.has(row.model)) {
      seenModels.add(row.model);
      models.push(row.model);
    }

    const confidence = Number(row.confidence);
    if (Number.isFinite(confidence)) {
      confidenceSum += confidence;
      confidenceCount += 1;
    }

    const label = row.label ?? "unknown";
    labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
  }

  const topLabels = [...labelCounts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, TOP_LABELS);

  return {
    detections: rows.length,
    frames: timestamps.size,
    averageConfidence:
      confidenceCount > 0 ? confidenceSum / confidenceCount : 0,
    durationMs:
      firstTimestamp === null || lastTimestamp === null
        ? 0
        : lastTimestamp - firstTimestamp,
    models,
    topLabels,
    mostFrequent: topLabels[0]?.label ?? "none",
  };
}

function formatDistance(meters) {
  if (!Number.isFinite(meters) || meters <= 0) {
    return "—";
  }
  if (meters < 1000) {
    return `${Math.round(meters)} m`;
  }
  return `${(meters / 1000).toFixed(2)} km`;
}

function summaryParagraph(stats, subject) {
  if (stats.detections === 0) {
    return (
      `${subject} captured ${countLabel(stats.moments, "moment", "moments")} ` +
      `with ${countLabel(stats.captureFrames, "frame", "frames")} over ${formatDuration(stats.durationMs)}. ` +
      `No live detections were logged (inference may have been paused while recording).`
    );
  }
  return (
    `${subject} logged ${countLabel(stats.detections, "detection", "detections")} ` +
    `across ${countLabel(stats.frames, "frame", "frames")} over ${formatDuration(stats.durationMs)}, ` +
    `using ${joinList(stats.models)}. The most frequent label was ${stats.mostFrequent}; ` +
    `average confidence was ${stats.averageConfidence.toFixed(2)}.`
  );
}

function themeColor(name, fallback) {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return value || fallback;
}

function destroyChart() {
  chart?.destroy();
  chart = null;
}

function chartAriaLabel(topLabels) {
  const parts = topLabels.map((item) => `${item.label} ${item.count}`);
  return `Horizontal bar chart of the most frequent labels: ${parts.join(", ")}`;
}

function drawChart(Chart, topLabels) {
  const canvas = document.getElementById("summary-labels-chart");
  if (!canvas) {
    return;
  }
  destroyChart();
  canvas.setAttribute("aria-label", chartAriaLabel(topLabels));

  const text = themeColor("--color-text", "#222222");
  const subtle = themeColor("--color-text-subtle", "#777777");
  const border = themeColor("--color-border", "#e5e5e5");
  const accent = themeColor("--color-accent", "#2563eb");
  const fontFamily = getComputedStyle(document.body).fontFamily;

  chart = new Chart(canvas, {
    type: "bar",
    data: {
      labels: topLabels.map((item) => item.label),
      datasets: [
        {
          data: topLabels.map((item) => item.count),
          backgroundColor: accent,
          borderRadius: 4,
          maxBarThickness: 28,
        },
      ],
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label(context) {
              return countLabel(
                Math.round(context.parsed.x),
                "detection",
                "detections",
              );
            },
          },
        },
      },
      scales: {
        x: {
          beginAtZero: true,
          ticks: {
            color: subtle,
            precision: 0,
            font: { family: fontFamily },
            callback(value) {
              return Math.round(value);
            },
          },
          grid: { color: border },
          border: { color: border },
        },
        y: {
          ticks: {
            color: text,
            font: { family: fontFamily },
          },
          grid: { display: false },
          border: { color: border },
        },
      },
    },
  });
}

function setSummaryValue(name, value) {
  const node = document.querySelector(`[data-summary="${name}"]`);
  if (node) {
    node.textContent = value;
  }
}

function renderSummary(stats, subject) {
  setSummaryValue("detections", String(stats.detections));
  setSummaryValue("frames", String(stats.frames));
  setSummaryValue("confidence", stats.averageConfidence.toFixed(2));
  setSummaryValue("duration", formatDuration(stats.durationMs));
  const paragraph = document.getElementById("summary-text");
  if (paragraph) {
    paragraph.textContent = summaryParagraph(stats, subject);
  }
}

function statusLabel(recording) {
  const status = recording.annotation_status;
  if (!hasGeminiApiKey()) {
    return "Needs API key";
  }
  if (status === "pending") {
    return "Pending";
  }
  if (status === "failed") {
    return "Failed";
  }
  if (status === "done") {
    return "Done";
  }
  if (status === "skipped") {
    return "Skipped";
  }
  return "—";
}

function revokeThumbUrl(img) {
  const url = img?.dataset?.objectUrl;
  if (url) {
    URL.revokeObjectURL(url);
    delete img.dataset.objectUrl;
  }
}

function renderMomentCard(recording, takenAt) {
  const live = getRecordingById(recording.recording_id) ?? recording;
  const id = live.recording_id;
  const card = document.createElement("article");
  card.className = "moment-card";
  card.dataset.recordingId = String(id);

  const header = document.createElement("div");
  header.className = "moment-card__header";
  const title = document.createElement("h3");
  title.className = "moment-card__title";
  title.textContent =
    live.end_time == null
      ? `Recording ${id} (in progress)`
      : `Recording ${id}`;
  const meta = document.createElement("p");
  meta.className = "moment-card__meta";
  meta.textContent = [
    formatClockTime(live.start_time),
    formatDuration(recordingDurationMs(live, takenAt)),
    formatDistance(trackDistanceMeters(live.track)),
    `${live.frames?.length ?? 0} frames`,
  ].join(" · ");
  header.append(title, meta);

  const body = document.createElement("div");
  body.className = "moment-card__body";

  const thumbWrap = document.createElement("div");
  thumbWrap.className = "moment-card__thumb";
  const firstFrame = live.frames?.find((frame) => frame?.jpeg instanceof Blob);
  if (firstFrame) {
    const img = document.createElement("img");
    img.alt = `First frame of recording ${id}`;
    const url = URL.createObjectURL(firstFrame.jpeg);
    img.src = url;
    img.dataset.objectUrl = url;
    thumbWrap.appendChild(img);
  } else {
    thumbWrap.textContent = "No frame";
  }

  const copy = document.createElement("div");
  copy.className = "moment-card__copy";

  const youSaid = document.createElement("div");
  youSaid.className = "moment-card__block";
  const youLabel = document.createElement("h4");
  youLabel.textContent = "You said";
  const youText = document.createElement("p");
  youText.textContent =
    live.transcript_status === "pending"
      ? "Transcribing…"
      : live.transcript_status === "failed"
        ? "Transcript failed."
        : live.transcript || "—";
  youSaid.append(youLabel, youText);

  const aiSaid = document.createElement("div");
  aiSaid.className = "moment-card__block";
  const aiLabel = document.createElement("h4");
  aiLabel.textContent = "AI said";
  const aiText = document.createElement("p");
  aiText.textContent =
    live.description_status === "pending"
      ? "Describing…"
      : live.description_status === "failed"
        ? "Description failed."
        : live.ai_description || "—";
  aiSaid.append(aiLabel, aiText);

  copy.append(youSaid, aiSaid);
  body.append(thumbWrap, copy);

  const footer = document.createElement("div");
  footer.className = "moment-card__footer";
  const status = document.createElement("span");
  status.className = `moment-card__status moment-card__status--${live.annotation_status ?? "none"}`;
  status.textContent = statusLabel(live);

  const actions = document.createElement("div");
  actions.className = "moment-card__actions";
  const playBtn = document.createElement("button");
  playBtn.type = "button";
  playBtn.className = "btn btn--secondary summary-play-btn";
  playBtn.textContent = "Play";
  playBtn.disabled = !live.audio_blob;
  playBtn.addEventListener("click", () => playRecordingAudio(live));
  actions.appendChild(playBtn);

  if (live.annotation_status === "failed") {
    const retryBtn = document.createElement("button");
    retryBtn.type = "button";
    retryBtn.className = "btn btn--quiet summary-play-btn";
    retryBtn.textContent = "Retry";
    retryBtn.addEventListener("click", () => retryMomentAnnotation(id));
    actions.appendChild(retryBtn);
  }

  footer.append(status, actions);
  card.append(header, body, footer);
  return card;
}

function renderRecordingsTable(section, body, selection) {
  for (const img of body.querySelectorAll("img[data-object-url]")) {
    revokeThumbUrl(img);
  }
  const moments = selection.recordings ?? [];
  section.classList.toggle("hidden", moments.length === 0);
  body.replaceChildren();
  for (const recording of moments) {
    body.appendChild(renderMomentCard(recording, selection.takenAt));
  }
}

// The Review panel decides when the summary is visible; this only builds, clears, and re-measures it.
export function initSessionSummary() {
  const panel = document.getElementById("session-summary");
  const empty = document.getElementById("summary-empty");
  const content = document.getElementById("summary-content");
  const chartNote = document.getElementById("summary-chart-note");
  const recordingsSection = document.getElementById("summary-recordings");
  const recordingsBody = document.getElementById("summary-recordings-body");

  if (!panel || !empty || !content || !recordingsSection || !recordingsBody) {
    return null;
  }

  let activeSelection = null;

  function close() {
    openGeneration += 1;
    destroyChart();
    for (const img of recordingsBody.querySelectorAll("img[data-object-url]")) {
      revokeThumbUrl(img);
    }
    activeSelection = null;
  }

  onRecordingUpdated((recording) => {
    if (!activeSelection) {
      return;
    }
    const card = recordingsBody.querySelector(
      `[data-recording-id="${recording.recording_id}"]`,
    );
    if (!card) {
      return;
    }
    const next = renderMomentCard(recording, activeSelection.takenAt);
    for (const img of card.querySelectorAll("img[data-object-url]")) {
      revokeThumbUrl(img);
    }
    card.replaceWith(next);
  });

  async function open(selection) {
    const generation = ++openGeneration;
    const rows = selection.rows;
    const moments = selection.recordings ?? [];
    activeSelection = selection;
    panel.scrollTop = 0;

    const hasContent = rows.length > 0 || moments.length > 0;
    empty.classList.toggle("hidden", hasContent);
    content.classList.toggle("hidden", !hasContent);
    if (!hasContent) {
      destroyChart();
      return;
    }

    const stats = summarizeDetectionLog(rows);
    // Start-to-stop time of each recording, so gaps between recordings don't count.
    stats.durationMs = moments.reduce(
      (sum, recording) =>
        sum + recordingDurationMs(recording, selection.takenAt),
      0,
    );
    stats.moments = moments.length;
    stats.captureFrames = moments.reduce(
      (sum, recording) => sum + (recording.frames?.length ?? 0),
      0,
    );
    if (rows.length === 0) {
      stats.frames = stats.captureFrames;
    }
    renderSummary(stats, selection.all ? "These recordings" : "This recording");
    renderRecordingsTable(recordingsSection, recordingsBody, selection);
    if (chartNote) {
      chartNote.textContent = "";
      chartNote.classList.add("hidden");
    }

    if (stats.topLabels.length === 0) {
      destroyChart();
      return;
    }

    try {
      const Chart = await loadChartJs();
      if (generation !== openGeneration || !Chart) {
        return;
      }
      drawChart(Chart, stats.topLabels);
    } catch (error) {
      console.error("[SUMMARY] chart failed:", error);
      if (generation !== openGeneration) {
        return;
      }
      destroyChart();
      if (chartNote) {
        chartNote.textContent = "The label chart could not be loaded.";
        chartNote.classList.remove("hidden");
      }
    }
  }

  function resize() {
    chart?.resize();
  }

  return { open, close, resize };
}
