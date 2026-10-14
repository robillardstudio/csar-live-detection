// On-demand snapshot of the in-memory detection log. Does not record, detect, or export.
import { getLiveDetectionLog } from "../live/detection-log.js";

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

function summaryParagraph(stats) {
  return (
    `This session recorded ${countLabel(stats.detections, "detection", "detections")} ` +
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

function renderSummary(stats) {
  setSummaryValue("detections", String(stats.detections));
  setSummaryValue("frames", String(stats.frames));
  setSummaryValue("confidence", stats.averageConfidence.toFixed(2));
  setSummaryValue("duration", formatDuration(stats.durationMs));
  const paragraph = document.getElementById("summary-text");
  if (paragraph) {
    paragraph.textContent = summaryParagraph(stats);
  }
}

// The Review panel decides when the summary is visible; this only builds, clears, and re-measures it.
export function initSessionSummary() {
  const panel = document.getElementById("session-summary");
  const empty = document.getElementById("summary-empty");
  const content = document.getElementById("summary-content");
  const chartNote = document.getElementById("summary-chart-note");

  if (!panel || !empty || !content) {
    return null;
  }

  function close() {
    openGeneration += 1;
    destroyChart();
  }

  async function open() {
    const generation = ++openGeneration;
    const rows = getLiveDetectionLog().slice();
    panel.scrollTop = 0;

    const hasRows = rows.length > 0;
    empty.classList.toggle("hidden", hasRows);
    content.classList.toggle("hidden", !hasRows);
    if (!hasRows) {
      destroyChart();
      return;
    }

    const stats = summarizeDetectionLog(rows);
    renderSummary(stats);
    if (chartNote) {
      chartNote.textContent = "";
      chartNote.classList.add("hidden");
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
