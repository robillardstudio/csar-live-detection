// Live page: camera loop, stats, recording toggle, and export buttons.
// Detection goes through objects.js / models.js; GPS, compass, and the log live in geolocation.js, compass.js, and detection-log.js.
import { RawImage } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.2.1";
import { requestCameraStream, showCameraFeedback } from "../utils/camera.js";
import {
  getActiveSlot,
  getModelEngine,
  getModelId,
  getModelTask,
  getObjectDetectorBackend,
  loadModel,
  MODEL_OPTIONS,
  setDetectionModel,
  setLiveDetectionActive,
} from "../models.js";
import { detectBoxesInImage } from "../live/gemini-client.js";
import {
  BOXES_PROMPT,
  getGeminiModelId,
  hasGeminiApiKey,
} from "../live/gemini-settings.js";
import { createGpsTracker } from "../utils/geolocation.js";
import { createCompassTracker, requestCompassPermission } from "../utils/compass.js";
import { objectBearing } from "../utils/bearing.js";
import {
  DISTANCE_METHOD,
  estimateDistance,
  projectPosition,
} from "../utils/position.js";
import {
  clearLiveDetectionLog,
  getLiveDetectionLogCount,
  getRecordings,
  getUnexportedRecordingCount,
  logDetectionFrame,
  markRecordingsExported,
  startRecording,
  stopRecording,
} from "../live/detection-log.js";
import {
  exportLiveDetectionCsv,
  exportLiveDetectionJson,
} from "../live/export-live.js";
import {
  detectObjectsFromSource,
  renderBoundingBoxesOnContainer,
  setSelectedBoundingBox,
} from "../analysis/objects.js";
import { classifyImageFromSource } from "../analysis/classify.js";
import {
  getGeminiAutoLookSeconds,
  getSettings,
  initGeminiSettings,
  initModelPicker,
  initStillSettings,
  setModelPickersDisabled,
  syncGeminiSettingsVisibility,
  syncModelPickers,
  syncNoiseSettingsUi,
} from "./sidebar.js";
import { initModelsSheet } from "./details-sheet.js";
import { getSelectedRecordingId } from "./app-mode.js";
import {
  STILL_SENSITIVITY,
  copyThumbnail,
  createThumbnailBuffer,
  distanceMeters,
  grabGrayscaleThumbnail,
  meanAbsDiff,
} from "../utils/scene-diff.js";

function formatElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

const NO_COMPASS_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M4 4l16 16"/></svg>`;

const ROLLING_WINDOW = 30;
// Cap the longest edge at 640px so full-resolution camera frames don't exhaust memory on mobile Safari.
const MAX_INFERENCE_EDGE = 640;
const STILL_MOVE_M = 3;
const HEARTBEAT_MS = 10_000;
// Per recording: skip a label already logged within max(15 m, current gps_accuracy).
const LABEL_PLACE_RADIUS_M = 15;
const GPS_GOOD_ACCURACY_M = 25;
const COUNT_IN_VIEW_WINDOW_MS = 2000;

// Coarse-pointer devices (iPad etc.) wait ~700ms between completed inferences so memory can release.
// Desktop stays uncapped unless Analyses/sec is set (MobileNet default 2; detectors default Max).
function deviceInferenceIntervalMs() {
  const coarsePointer =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(pointer: coarse)").matches;
  return coarsePointer ? 700 : 0;
}

function inferenceIntervalMsFromSettings() {
  const rate = Number(getSettings().analysesPerSecond);
  if (!Number.isFinite(rate) || rate <= 0) {
    return deviceInferenceIntervalMs();
  }
  return Math.max(1000 / rate, deviceInferenceIntervalMs());
}

function createLiveMetricsTracker() {
  const inferenceTimes = [];
  let frameCount = 0;

  return {
    reset() {
      inferenceTimes.length = 0;
      frameCount = 0;
    },
    recordInferenceMs(ms) {
      frameCount += 1;
      inferenceTimes.push(ms);
      if (inferenceTimes.length > ROLLING_WINDOW) {
        inferenceTimes.shift();
      }
    },
    getSnapshot() {
      const instantMs = inferenceTimes.at(-1) ?? null;
      const rollingAvgMs =
        inferenceTimes.length > 0
          ? inferenceTimes.reduce((sum, value) => sum + value, 0) /
            inferenceTimes.length
          : null;
      const effectiveFps =
        rollingAvgMs && rollingAvgMs > 0 ? 1000 / rollingAvgMs : null;
      return { instantMs, rollingAvgMs, effectiveFps, frameCount };
    },
  };
}

function formatMetricMs(value) {
  return value === null ? "—" : `${Math.round(value)} ms`;
}

function formatMetricFps(value) {
  return value === null ? "—" : value.toFixed(2);
}

function friendlyModelLabel(modelId) {
  const label =
    MODEL_OPTIONS.find((item) => item.id === modelId)?.label ?? modelId;
  return label.replace(/\s*\([^)]*\)\s*$/, "");
}

function formatGpsAccuracy(fix) {
  return fix?.accuracy == null ? "—" : `±${Math.round(fix.accuracy)}m`;
}

function formatDebugLine(reading, compassTracker = null) {
  const debug = reading?.debug || compassTracker?.getDebug?.() || null;
  if (!debug) {
    return "debug: (none yet)";
  }
  return `debug: ${debug.events || "events?"} · type=${debug.type ?? "—"} · alpha=${debug.alpha ?? "—"} · absolute=${debug.absolute ?? "—"}`;
}

// TEMPORARY field-test display: corrected camera heading, plus the raw inputs it came from.
function formatHeading(reading, status = null, compassTracker = null) {
  const debugLine = formatDebugLine(reading, compassTracker);
  if (reading?.heading != null) {
    const degrees = (value) => `${Math.round(value) % 360}°`;
    const camera =
      reading.cameraHeading == null ? "—" : degrees(reading.cameraHeading);
    const accuracy =
      reading.accuracy == null ? "" : ` (±${Math.round(reading.accuracy)}°)`;
    const screenAngle =
      reading.screenAngle == null ? "—" : `${reading.screenAngle}°`;
    return {
      main: `${camera}${accuracy}`,
      detail: `raw ${degrees(reading.heading)}, screen ${screenAngle}\n${debugLine}`,
      available: true,
    };
  }
  const relativeOnly =
    status === "relative-only" ||
    reading?.relativeOnly === true ||
    compassTracker?.isRelativeOnly?.() === true;
  const reason =
    status === "denied"
      ? "Permission denied"
      : status === "unavailable"
        ? "Not supported"
        : status === "waiting"
          ? "Waiting for compass…"
          : relativeOnly
            ? "Relative only (no north reference)"
            : "No sensor events";
  return { main: reason, detail: debugLine, available: false };
}

function computeInferenceSize(videoW, videoH) {
  const longest = Math.max(videoW, videoH);
  if (longest <= MAX_INFERENCE_EDGE) {
    return { width: videoW, height: videoH };
  }
  const scale = MAX_INFERENCE_EDGE / longest;
  return {
    width: Math.max(1, Math.round(videoW * scale)),
    height: Math.max(1, Math.round(videoH * scale)),
  };
}

function createPipelineInputHelper(ctx) {
  let rawImage = null;

  // Transformers.js rejects a raw <canvas>; reuse one RawImage (JPEG data URL if RawImage is unavailable) to avoid per-frame allocations.
  return function canvasToPipelineInput(canvas) {
    if (typeof RawImage !== "function") {
      return canvas.toDataURL("image/jpeg", 0.85);
    }

    const { width, height } = canvas;
    const imageData = ctx.getImageData(0, 0, width, height);
    if (
      rawImage &&
      rawImage.width === width &&
      rawImage.height === height &&
      rawImage.data?.length === imageData.data.length
    ) {
      rawImage.data.set(imageData.data);
      return rawImage;
    }

    rawImage = new RawImage(
      new Uint8ClampedArray(imageData.data),
      width,
      height,
      4,
    );
    return rawImage;
  };
}

export function initLiveDetectionPage(annotate = null) {
  const video = document.getElementById("live-video");
  const stage = document.getElementById("live-stage");
  const livePanel = document.getElementById("live-panel");
  const feed = document.getElementById("live-feed");
  const idle = document.getElementById("live-idle");
  const mediaWrap = document.querySelector(".live-stage__media");
  const liveToggle = document.getElementById("btn-live-toggle");
  const mainStart = document.getElementById("btn-live-start-main");
  const liveStartMobile = document.getElementById("btn-live-start-mobile");
  const liveStop = document.getElementById("btn-live-stop");
  const sessionIdle = document.getElementById("session-idle");
  const sessionLive = document.getElementById("session-live");
  const recordButton = document.getElementById("btn-record");
  const recordButtonMobile = document.getElementById("btn-record-mobile");
  const recordButtonLive = document.getElementById("btn-record-live");
  const exportButton = document.getElementById("btn-export");
  const exportMenu = document.getElementById("export-menu");
  const clearButton = document.getElementById("btn-clear-recordings");
  const changeModelBtn = document.getElementById("btn-change-model");
  const sessionModelName = document.getElementById("session-model-name");
  const sessionRunStatus = document.getElementById("session-run-status");
  const recSub = document.getElementById("rec-sub");
  const recBadge = document.getElementById("rec-badge");
  const recBadgeTime = document.getElementById("rec-badge-time");
  const liveBadge = document.querySelector("[data-live-badge]");
  const recordRows = document.querySelectorAll(".switchrow");
  const headingMetric = document.querySelector("[data-heading-metric]");
  const fpsMetric = document.querySelector("[data-fps-metric]");
  const detailsSub = document.getElementById("details-sheet-sub");
  const detailsModelName = document.getElementById("details-model-name");
  const detailsHeadingOk = document.getElementById("details-heading-ok");
  const detailsHeadingWarn = document.getElementById("details-heading-warn");
  const copyCoordsBtn = document.getElementById("btn-copy-coords");
  const gpsDot = document.querySelector("[data-gps-dot]");

  if (
    !video ||
    !stage ||
    !feed ||
    !mediaWrap ||
    !liveToggle ||
    !mainStart ||
    !recordButton ||
    !exportButton ||
    !exportMenu ||
    !clearButton
  ) {
    return;
  }

  const recordSwitches = [recordButtonMobile, recordButtonLive].filter(Boolean);

  const metrics = createLiveMetricsTracker();
  const frameCanvas = document.createElement("canvas");
  const frameCtx = frameCanvas.getContext("2d", { willReadFrequently: true });
  const canvasToPipelineInput = createPipelineInputHelper(frameCtx);

  let stream = null;
  let gps = null;
  let gpsFix = null;
  let compass = null;
  let headingText = null;
  let hasCompass = false;
  let backendInfo = null;
  let running = false;
  let busy = false;
  let switchingModel = false;
  let frozenLook = false;
  let looking = false;
  let lookAbort = null;
  let lookDetections = [];
  let lookPrompt = null;
  let lookTimestamp = 0;
  let autoLookTimerId = null;
  const freezeCanvas = document.getElementById("gemini-freeze");
  const lookButtons = [
    document.getElementById("btn-gemini-look"),
    document.getElementById("btn-gemini-look-sidebar"),
    document.getElementById("btn-gemini-look-mobile"),
  ].filter(Boolean);
  const resumeButtons = [
    document.getElementById("btn-gemini-resume"),
    document.getElementById("btn-gemini-resume-sidebar"),
    document.getElementById("btn-gemini-resume-mobile"),
  ].filter(Boolean);
  const lookCancelButtons = [
    document.getElementById("btn-gemini-look-cancel"),
    document.getElementById("btn-gemini-look-cancel-mobile"),
  ].filter(Boolean);
  const lookStatusNodes = [
    document.getElementById("gemini-look-status"),
    document.getElementById("gemini-look-status-mobile"),
  ].filter(Boolean);
  let isRecording = false;
  let recordArmed = false;
  let animationFrameId = null;
  let lastCompletedInferenceAt = 0;
  let frameW = 0;
  let frameH = 0;
  let logGeneration = 0;
  let sessionStartedAt = 0;
  let recordingStartedAt = 0;
  let uiTimerId = null;
  const thumbBuffer = createThumbnailBuffer();
  let lastLogThumb = null;
  let lastLogGps = null;
  let lastLogAt = 0;
  let lastGoodGpsFix = null;
  let lastLiveDetections = [];
  // Per recording: label → [{ lat, lon }] place logs (no time expiry).
  const labelPlaceLog = new Map();
  // Recent per-frame label counts for count_in_view (max in any frame in last 2 s).
  const recentFrameCounts = [];
  const stillIndicators = [
    document.getElementById("still-indicator"),
    document.querySelector("[data-still-sidebar]"),
  ].filter(Boolean);
  const captureCanvas = document.createElement("canvas");

  function setStillPaused(paused) {
    for (const node of stillIndicators) {
      node.hidden = !paused;
      node.classList.toggle("hidden", !paused);
    }
  }

  function placeRadiusM(gpsFix) {
    const accuracy = Number(gpsFix?.accuracy);
    if (!Number.isFinite(accuracy) || accuracy <= 0) {
      return LABEL_PLACE_RADIUS_M;
    }
    return Math.max(LABEL_PLACE_RADIUS_M, accuracy);
  }

  function wasLoggedNearPlace(label, gpsFix) {
    const entries = labelPlaceLog.get(label);
    if (!entries?.length) {
      return false;
    }
    const radius = placeRadiusM(gpsFix);
    for (const entry of entries) {
      if (gpsFix?.lat == null || gpsFix?.lon == null || entry.lat == null) {
        return true;
      }
      if (
        distanceMeters(gpsFix, { lat: entry.lat, lon: entry.lon }) <= radius
      ) {
        return true;
      }
    }
    return false;
  }

  function rememberLabelPlaces(detections, gpsFix) {
    for (const detection of detections) {
      const label = String(detection.label ?? "").trim();
      if (!label) {
        continue;
      }
      if (!labelPlaceLog.has(label)) {
        labelPlaceLog.set(label, []);
      }
      labelPlaceLog.get(label).push({
        lat: gpsFix?.lat ?? null,
        lon: gpsFix?.lon ?? null,
      });
    }
  }

  function noteFrameLabelCounts(detections, now) {
    const byLabel = new Map();
    for (const detection of detections) {
      const label = String(detection.label ?? "").trim();
      if (!label) {
        continue;
      }
      byLabel.set(label, (byLabel.get(label) ?? 0) + 1);
    }
    recentFrameCounts.push({ at: now, byLabel });
    while (
      recentFrameCounts.length &&
      now - recentFrameCounts[0].at > COUNT_IN_VIEW_WINDOW_MS
    ) {
      recentFrameCounts.shift();
    }
  }

  function maxCountInView(label, now = Date.now()) {
    const needle = String(label ?? "").trim();
    if (!needle) {
      return 0;
    }
    let max = 0;
    for (const frame of recentFrameCounts) {
      if (now - frame.at > COUNT_IN_VIEW_WINDOW_MS) {
        continue;
      }
      max = Math.max(max, frame.byLabel.get(needle) ?? 0);
    }
    return max;
  }

  function withCountInView(detections, now) {
    return detections.map((detection) => ({
      ...detection,
      countInView: maxCountInView(detection.label, now),
    }));
  }

  function resolveGpsForLog(rawFix) {
    if (!rawFix || rawFix.lat == null || rawFix.lon == null) {
      return { fix: rawFix ?? null, gpsQuality: null };
    }
    const accuracy = Number(rawFix.accuracy);
    if (Number.isFinite(accuracy) && accuracy <= GPS_GOOD_ACCURACY_M) {
      lastGoodGpsFix = {
        lat: rawFix.lat,
        lon: rawFix.lon,
        accuracy: rawFix.accuracy,
        timestamp: rawFix.timestamp,
      };
      return { fix: rawFix, gpsQuality: "good" };
    }
    if (lastGoodGpsFix) {
      return {
        fix: {
          lat: lastGoodGpsFix.lat,
          lon: lastGoodGpsFix.lon,
          accuracy: rawFix.accuracy,
          timestamp: rawFix.timestamp,
        },
        gpsQuality: "low",
      };
    }
    return { fix: rawFix, gpsQuality: "low" };
  }

  function markLoggedFrame(thumb, gpsFix, at) {
    lastLogThumb = copyThumbnail(thumb);
    lastLogGps = gpsFix ? { lat: gpsFix.lat, lon: gpsFix.lon } : null;
    lastLogAt = at;
  }

  function resetStillState() {
    lastLogThumb = null;
    lastLogGps = null;
    lastLogAt = 0;
    labelPlaceLog.clear();
    recentFrameCounts.length = 0;
    setStillPaused(false);
  }

  function resetRecordingPlaceLog() {
    labelPlaceLog.clear();
  }

  function selectLiveDetection(label, detection, timestamp, gpsSnap) {
    if (!label) {
      annotate?.selectLabel?.(null);
      setSelectedBoundingBox(mediaWrap, null);
      return;
    }
    const tapAt = timestamp ?? Date.now();
    const { fix: tapGps, gpsQuality: tapQuality } = resolveGpsForLog(
      gpsSnap ?? gpsFix,
    );
    if (lastLiveDetections.length) {
      noteFrameLabelCounts(lastLiveDetections, tapAt);
    }
    // Always log the tapped box as its own AI row (bypass place dedupe).
    const [logged] = logDetectionFrame({
      detections: withCountInView(
        [
          {
            ...(detection ?? { label, box: null }),
            label,
          },
        ],
        tapAt,
      ),
      frameW,
      frameH,
      inferenceMs: null,
      timestamp: tapAt,
      gpsFix: tapGps,
      orientation: compass?.getReading() ?? null,
      backend: backendInfo,
      modelId: getModelId(),
      forceLog: true,
      gpsQuality: tapQuality,
    });
    if (logged?.id != null) {
      rememberLabelPlaces([{ label }], tapGps);
      annotate?.noteLiveLabels?.([
        {
          label,
          score: detection?.score ?? null,
          box: detection?.box ?? null,
          frameW,
          frameH,
          rowId: logged.id,
        },
      ]);
    }
    annotate?.selectLabel?.(label, {
      box: detection?.box ?? null,
      box2d: detection?.box2d ?? null,
      frameW,
      frameH,
      timestamp: tapAt,
      gpsFix: tapGps,
      locked: true,
      rowId: logged?.id ?? null,
    });
    setSelectedBoundingBox(mediaWrap, label);
  }

  function logDetectionsIfNeeded(
    detections,
    {
      thumb,
      gpsFix,
      orientation,
      inferenceMs,
      now,
      generation,
      isStill,
      needsHeartbeat,
      gpsQuality = null,
    },
  ) {
    // Row ids aligned with `detections` (null when skipped / not recording).
    const aligned = detections.map(() => null);

    noteFrameLabelCounts(detections, now);

    if (!isRecording || generation !== logGeneration) {
      if (!isStill || needsHeartbeat) {
        markLoggedFrame(thumb, gpsFix, now);
      }
      return aligned;
    }

    const toLog = [];
    const toLogIndexes = [];
    const queuedLabels = new Set();
    for (let i = 0; i < detections.length; i += 1) {
      const detection = detections[i];
      const label = String(detection.label ?? "").trim();
      if (
        !label ||
        queuedLabels.has(label) ||
        wasLoggedNearPlace(label, gpsFix)
      ) {
        continue;
      }
      queuedLabels.add(label);
      toLog.push(detection);
      toLogIndexes.push(i);
    }

    if (!toLog.length) {
      if (!isStill || needsHeartbeat) {
        markLoggedFrame(thumb, gpsFix, now);
      }
      return aligned;
    }

    const logged = logDetectionFrame({
      detections: withCountInView(toLog, now),
      frameW,
      frameH,
      inferenceMs,
      timestamp: now,
      gpsFix,
      orientation,
      backend: backendInfo,
      modelId: getModelId(),
      gpsQuality,
    });
    for (let i = 0; i < logged.length; i += 1) {
      aligned[toLogIndexes[i]] = logged[i];
    }
    rememberLabelPlaces(toLog, gpsFix);
    markLoggedFrame(thumb, gpsFix, now);
    return aligned;
  }

  // A metric can appear in both the sidebar and the phone status strip.
  function setMetric(name, value) {
    for (const target of document.querySelectorAll(`[data-metric="${name}"]`)) {
      target.textContent = value;
    }
  }

  function setHeading(formatted) {
    const main = formatted?.main ?? "No sensor events";
    const detail = formatted?.detail ?? "";
    const available = Boolean(formatted?.available);
    const text = `${main}\n${detail}`;
    if (text === headingText && available === hasCompass) {
      return;
    }
    headingText = text;
    hasCompass = available;
    // Desktop sidebar + mobile strip show degrees or a concrete reason (not a blank "none").
    setMetric("heading", main);
    if (headingMetric) {
      if (available) {
        headingMetric.classList.remove("warn");
        headingMetric.innerHTML = `<span class="mono">${main}</span>`;
      } else {
        headingMetric.classList.add("warn");
        headingMetric.innerHTML = `${NO_COMPASS_ICON} <span>${main}</span>`;
      }
    }
    setMetric("heading-main", available ? main : "—");
    setMetric("heading-detail", detail || main);
    detailsHeadingOk?.toggleAttribute("hidden", !available);
    detailsHeadingWarn?.toggleAttribute("hidden", available);
  }

  function updateMetricsPanel() {
    const snapshot = metrics.getSnapshot();
    setMetric("instant", formatMetricMs(snapshot.instantMs));
    setMetric("avg", formatMetricMs(snapshot.rollingAvgMs));
    const fpsText = running
      ? formatMetricFps(snapshot.effectiveFps)
      : "–";
    setMetric("fps", fpsText);
    setMetric("fps-detail", fpsText);
    fpsMetric?.classList.toggle("muted", !running);
    setMetric("frames", String(snapshot.frameCount));
    setMetric("gps", formatGpsFix(gpsFix));
    setMetric("gps-accuracy", formatGpsAccuracy(gpsFix));
    setMetric("gps-accuracy-detail", formatGpsAccuracy(gpsFix));
    setMetric("logged", String(getLiveDetectionLogCount()));
    gpsDot?.classList.toggle("is-missing", !gpsFix);
    if (copyCoordsBtn) {
      copyCoordsBtn.hidden = !gpsFix;
    }
    // Mobile details sheet prefers compact coords in the coords span.
    for (const node of document.querySelectorAll(".coords[data-metric='gps']")) {
      node.textContent = formatGpsCoords(gpsFix);
    }
    updatePerfBar(snapshot);
    updateRecordingMetric();
  }

  function formatGpsFix(fix) {
    if (!fix) {
      return "—";
    }
    return `${fix.lat.toFixed(8)}, ${fix.lon.toFixed(8)}\n${formatGpsAccuracy(fix)}`;
  }

  function formatGpsCoords(fix) {
    if (!fix) {
      return "—";
    }
    return `${fix.lat.toFixed(5)}, ${fix.lon.toFixed(5)}`;
  }

  function updatePerfBar(snapshot) {
    const bar = document.querySelector("[data-perf-bar]");
    const note = document.querySelector("[data-perf-note]");
    const inf = document.querySelector("[data-perf-inference]");
    if (!bar || !note || !inf) {
      return;
    }
    const instant = snapshot.instantMs;
    const avg = snapshot.rollingAvgMs;
    if (!running || instant == null || avg == null || avg <= 0) {
      bar.hidden = true;
      note.hidden = true;
      return;
    }
    const pct = Math.max(1, Math.min(100, Math.round((instant / avg) * 100)));
    inf.style.width = `${pct}%`;
    bar.hidden = false;
    note.hidden = false;
    note.textContent = `Inference is ${pct}% of each frame. The rest is capture and drawing.`;
  }

  function updateRecordingMetric() {
    const node = document.querySelector('[data-metric="recording-state"]');
    if (!node) {
      return;
    }
    if (isRecording) {
      node.textContent = `On · ${formatElapsed(Date.now() - recordingStartedAt)}`;
      node.style.color = "var(--rec)";
    } else {
      node.textContent = "Off";
      node.style.color = "";
    }
  }

  function captureFrame() {
    if (!running) {
      return null;
    }
    if (frozenLook && freezeCanvas && !freezeCanvas.hidden) {
      const w = 112;
      const h = Math.max(
        1,
        Math.round((freezeCanvas.height / Math.max(1, freezeCanvas.width)) * w),
      );
      captureCanvas.width = w;
      captureCanvas.height = h;
      const ctx = captureCanvas.getContext("2d");
      ctx.drawImage(freezeCanvas, 0, 0, w, h);
      return captureCanvas.toDataURL("image/jpeg", 0.7);
    }
    if (!video.videoWidth || !video.videoHeight) {
      return null;
    }
    const w = 112;
    const h = Math.max(1, Math.round((video.videoHeight / video.videoWidth) * w));
    captureCanvas.width = w;
    captureCanvas.height = h;
    const ctx = captureCanvas.getContext("2d");
    ctx.drawImage(video, 0, 0, w, h);
    return captureCanvas.toDataURL("image/jpeg", 0.7);
  }

  function toastLookError(message) {
    const text = message || "look_failed";
    showCameraFeedback(text);
    annotate?.showStatusToast?.(text);
  }

  function setLookingUi(isLooking) {
    looking = isLooking;
    for (const node of lookStatusNodes) {
      node.hidden = !isLooking;
    }
    for (const button of lookCancelButtons) {
      button.disabled = !isLooking;
    }
    for (const button of lookButtons) {
      button.disabled = isLooking || !running || !isGeminiBoxes();
      button.textContent = "Look";
    }
  }

  function syncLookControls() {
    const gemini = isGeminiBoxes();
    syncGeminiSettingsVisibility();
    for (const button of lookButtons) {
      button.hidden = !gemini || !running || frozenLook;
      button.classList.toggle("hidden", button.hidden);
      button.disabled = looking || !running || !gemini;
    }
    for (const button of resumeButtons) {
      button.hidden = !gemini || !frozenLook;
      button.classList.toggle("hidden", button.hidden);
      // Resume must stay tappable during Analysing… (aborts + unfreezes).
      button.disabled = false;
    }
    for (const node of lookStatusNodes) {
      node.hidden = !looking;
    }
  }

  function abortLookRequest() {
    if (lookAbort) {
      lookAbort.abort("cancelled");
      lookAbort = null;
    }
  }

  function clearAutoLookTimer() {
    if (autoLookTimerId != null) {
      window.clearInterval(autoLookTimerId);
      autoLookTimerId = null;
    }
  }

  function scheduleAutoLook() {
    clearAutoLookTimer();
    const seconds = getGeminiAutoLookSeconds();
    if (!running || !isGeminiBoxes() || frozenLook || looking || seconds <= 0) {
      return;
    }
    autoLookTimerId = window.setInterval(() => {
      if (!running || !isGeminiBoxes() || frozenLook || looking) {
        return;
      }
      void runGeminiLook();
    }, seconds * 1000);
  }

  function clearLookOverlay() {
    mediaWrap.querySelector(".bounding-boxes")?.remove();
    if (freezeCanvas) {
      freezeCanvas.hidden = true;
    }
  }

  // Downscale for the API only — full-res freeze stays on screen for boxes.
  function encodeLookJpeg(sourceCanvas) {
    const maxW = 1024;
    let width = sourceCanvas.width;
    let height = sourceCanvas.height;
    if (width > maxW) {
      height = Math.max(1, Math.round((height * maxW) / width));
      width = maxW;
    }
    const encodeCanvas = document.createElement("canvas");
    encodeCanvas.width = width;
    encodeCanvas.height = height;
    const ctx = encodeCanvas.getContext("2d");
    ctx.drawImage(sourceCanvas, 0, 0, width, height);
    return new Promise((resolve, reject) => {
      encodeCanvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("encode_failed"))),
        "image/jpeg",
        0.8,
      );
    });
  }

  function resumeFromLook() {
    abortLookRequest();
    frozenLook = false;
    lookDetections = [];
    lookPrompt = null;
    lookTimestamp = 0;
    clearLookOverlay();
    if (video.srcObject && video.paused) {
      void video.play().catch(() => {});
    }
    annotate?.setLiveAnnotateState({ frozen: false });
    annotate?.selectLabel?.(null);
    setLookingUi(false);
    syncLookControls();
    scheduleAutoLook();
  }

  function cancelGeminiLook() {
    if (!looking) {
      return;
    }
    abortLookRequest();
  }

  async function runGeminiLook() {
    // isLooking guard — Auto-look must not stack a second in-flight request.
    if (!running || looking || !isGeminiBoxes()) {
      return;
    }
    if (!hasGeminiApiKey()) {
      toastLookError("missing_api_key — add a Gemini API key in settings");
      return;
    }
    if (!video.videoWidth || !video.videoHeight) {
      toastLookError("no_frame — camera is not ready");
      return;
    }
    if (!freezeCanvas) {
      toastLookError("freeze_canvas_missing");
      return;
    }

    clearAutoLookTimer();
    lookAbort = new AbortController();
    const signal = lookAbort.signal;
    setLookingUi(true);

    const width = video.videoWidth;
    const height = video.videoHeight;
    freezeCanvas.width = width;
    freezeCanvas.height = height;
    const ctx = freezeCanvas.getContext("2d");
    ctx.drawImage(video, 0, 0, width, height);
    freezeCanvas.hidden = false;
    video.pause();
    frozenLook = true;
    lookTimestamp = Date.now();
    annotate?.setLiveAnnotateState({ frozen: true });
    syncLookControls();

    const t0 = performance.now();
    try {
      const jpeg = await encodeLookJpeg(freezeCanvas);
      if (signal.aborted) {
        throw new Error("cancelled");
      }
      const result = await detectBoxesInImage({
        image: jpeg,
        prompt: BOXES_PROMPT,
        signal,
      });
      if (signal.aborted) {
        throw new Error("cancelled");
      }
      const inferenceMs = performance.now() - t0;
      lookPrompt = result.prompt;
      const detections = (result.items || [])
        .slice(0, 15)
        .map((item) => {
          const box2d = item.box_2d;
          if (!Array.isArray(box2d) || box2d.length < 4) {
            return null;
          }
          const label = String(item.label ?? "").trim();
          if (!label) {
            return null;
          }
          return {
            label,
            score: null,
            box: box2dToPixels(box2d, width, height),
            box2d,
            prompt: lookPrompt,
          };
        })
        .filter(Boolean);

      lookDetections = detections;
      frameW = width;
      frameH = height;

      const { fix: lookGps, gpsQuality: lookGpsQuality } = resolveGpsForLog(gpsFix);
      noteFrameLabelCounts(detections, lookTimestamp);
      const logged = logDetectionFrame({
        detections: withCountInView(detections, lookTimestamp),
        frameW: width,
        frameH: height,
        inferenceMs,
        timestamp: lookTimestamp,
        gpsFix: lookGps,
        orientation: compass?.getReading() ?? null,
        backend: backendInfo ?? { device: "gemini", dtype: "api" },
        modelId: geminiModelLogId(),
        prompt: lookPrompt,
        forceLog: true,
        gpsQuality: lookGpsQuality,
      });

      renderBoundingBoxesOnContainer(mediaWrap, detections, freezeCanvas, {
        onSelectLabel: (label, detection) => {
          const index = Number.isInteger(Number(detection && detections.indexOf(detection)))
            ? detections.indexOf(detection)
            : detections.findIndex((item) => item.label === label);
          const hit =
            detection ?? (index >= 0 ? detections[index] : null) ??
            lookDetections.find((item) => item.label === label);
          const rowId = index >= 0 ? logged[index]?.id ?? null : logged.find((row) => row.label === label)?.id ?? null;
          annotate?.selectLabel?.(label, hit
            ? {
                box: hit.box,
                box2d: hit.box2d,
                frameW: width,
                frameH: height,
                timestamp: lookTimestamp,
                prompt: lookPrompt,
                gpsFix: lookGps,
                locked: true,
                rowId,
              }
            : { rowId, locked: true, timestamp: lookTimestamp, gpsFix: lookGps });
          setSelectedBoundingBox(mediaWrap, label);
        },
      });

      annotate?.noteLiveLabels(
        detections.map((item, index) => ({
          label: item.label,
          score: item.score,
          box: item.box,
          frameW: width,
          frameH: height,
          rowId: logged[index]?.id ?? null,
        })),
      );
      annotate?.setSuggestions(
        detections.map((item) => ({ label: item.label, score: null })),
      );
      annotate?.setLiveAnnotateState({
        frozen: true,
        frozenFrame: {
          detections,
          frameW: width,
          frameH: height,
          timestamp: lookTimestamp,
          prompt: lookPrompt,
        },
        captureFrame,
      });
      metrics.recordInferenceMs(inferenceMs);
      updateMetricsPanel();
    } catch (error) {
      const message = error?.message || "look_failed";
      console.error("[GEMINI] look failed:", message);
      // Resume aborts too — only toast Cancel / real errors while still frozen.
      if (message !== "cancelled" || frozenLook) {
        toastLookError(message);
      }
    } finally {
      lookAbort = null;
      setLookingUi(false);
      syncLookControls();
    }
  }

  function renderClassificationReadout(predictions) {
    const readout = document.getElementById("class-readout");
    if (!readout) {
      return;
    }
    if (!predictions?.length) {
      readout.hidden = true;
      readout.replaceChildren();
      return;
    }
    readout.replaceChildren(
      ...predictions.map((item) => {
        const li = document.createElement("li");
        li.textContent = `${item.label} — ${item.score.toFixed(2)}`;
        return li;
      }),
    );
    readout.hidden = false;
  }

  function syncRecordSwitches() {
    const on = isRecording || (!running && recordArmed);
    for (const button of recordSwitches) {
      button.setAttribute("aria-checked", String(on));
    }
    for (const row of recordRows) {
      row.classList.toggle("on", on);
    }
    if (recSub) {
      if (isRecording) {
        recSub.textContent = `Recording · ${formatElapsed(Date.now() - recordingStartedAt)}`;
      } else if (running) {
        recSub.textContent = "Start or stop any time";
      } else if (recordArmed) {
        recSub.textContent = "Will start with detection";
      } else {
        recSub.textContent = "Saves video alongside labels";
      }
    }
    for (const liveSub of document.querySelectorAll(".rec-sub-live")) {
      liveSub.textContent = isRecording
        ? `Recording · ${formatElapsed(Date.now() - recordingStartedAt)}`
        : "Start or stop any time";
    }
    if (recBadge && recBadgeTime) {
      recBadge.hidden = !isRecording;
      if (isRecording) {
        recBadgeTime.textContent = `REC ${formatElapsed(Date.now() - recordingStartedAt)}`;
      }
    }
    updateRecordingMetric();
  }

  function updateSessionChrome() {
    const modelLabel = friendlyModelLabel(getModelId());
    if (sessionModelName) {
      sessionModelName.textContent = modelLabel;
    }
    if (detailsModelName) {
      detailsModelName.textContent = modelLabel;
    }
    if (sessionRunStatus) {
      if (switchingModel) {
        sessionRunStatus.innerHTML = `<span class="spin"></span>Loading model…`;
      } else if (running) {
        sessionRunStatus.textContent = `Running · ${formatElapsed(Date.now() - sessionStartedAt)}`;
      }
    }
    if (changeModelBtn) {
      changeModelBtn.disabled = switchingModel;
    }
    if (detailsSub) {
      detailsSub.textContent = running ? "Updating live" : "Last session";
    }
  }

  function updateControls() {
    // Desktop header + idle controls
    liveToggle.textContent = running
      ? "Stop Live Detection"
      : "Start Live Detection";
    liveToggle.setAttribute("aria-pressed", String(running));
    liveToggle.disabled = switchingModel;
    if (mainStart) {
      mainStart.disabled = switchingModel || running;
    }
    recordButton.disabled = !running;
    recordButton.textContent = isRecording
      ? "Stop Recording"
      : "Start Recording";
    recordButton.setAttribute("aria-pressed", String(isRecording));
    recordButton.classList.toggle("btn--record-active", isRecording);

    // Shared camera visibility
    feed.hidden = !running;
    if (idle) {
      idle.hidden = running;
    }
    livePanel?.classList.toggle("is-live", running);
    if (liveBadge) {
      liveBadge.hidden = !running;
    }

    // Mobile session card
    if (sessionIdle) {
      sessionIdle.hidden = running;
    }
    if (sessionLive) {
      sessionLive.hidden = !running;
    }
    if (liveStartMobile) {
      liveStartMobile.disabled = switchingModel || running;
    }
    if (liveStop) {
      liveStop.disabled = switchingModel || !running;
    }
    syncLookControls();

    clearButton.disabled = getRecordings().length === 0;
    syncRecordSwitches();
    updateSessionChrome();
  }

  function tickUiClocks() {
    if (!running && !isRecording) {
      return;
    }
    updateSessionChrome();
    syncRecordSwitches();
  }

  function stopStream() {
    for (const track of stream?.getTracks?.() ?? []) {
      track.stop();
    }
    stream = null;
    video.srcObject = null;
  }

  function stopLiveDetection() {
    running = false;
    busy = false;
    clearAutoLookTimer();
    if (frozenLook) {
      resumeFromLook();
    }
    if (isRecording) {
      stopRecording();
    }
    isRecording = false;
    recordArmed = false;
    setLiveDetectionActive(false);
    compass?.stop();
    compass = null;
    if (animationFrameId !== null) {
      cancelAnimationFrame(animationFrameId);
      animationFrameId = null;
    }
    stopStream();
    mediaWrap.querySelector(".bounding-boxes")?.remove();
    renderClassificationReadout(null);
    annotate?.setSuggestions([]);
    setHeading(formatHeading(null, "waiting"));
    updateControls();
    updateMetricsPanel();
    annotate?.setLiveAnnotateState({
      running: false,
      frozen: false,
      orientation: null,
      gpsFix,
    });
    setStillPaused(false);
  }

  function isGeminiBoxes() {
    return getModelEngine() === "gemini";
  }

  function geminiModelLogId() {
    return `gemini:${getGeminiModelId()}`;
  }

  function box2dToPixels(box2d, width, height) {
    const [ymin, xmin, ymax, xmax] = box2d.map(Number);
    return {
      xmin: (xmin / 1000) * width,
      ymin: (ymin / 1000) * height,
      xmax: (xmax / 1000) * width,
      ymax: (ymax / 1000) * height,
    };
  }

  async function tick() {
    // Single-in-flight: never start a new inference while one is running, so frames cannot pile up.
    // Gemini Look is on-demand — skip the per-frame loop while frozen or when that model is selected.
    if (!running || busy || switchingModel || frozenLook || isGeminiBoxes()) {
      return;
    }
    // Throttle from last *completed* inference using per-model Analyses per second.
    const intervalMs = inferenceIntervalMsFromSettings();
    if (
      intervalMs > 0 &&
      performance.now() - lastCompletedInferenceAt < intervalMs
    ) {
      return;
    }

    const videoW = video.videoWidth;
    const videoH = video.videoHeight;
    if (!videoW || !videoH) {
      return;
    }

    const sized = computeInferenceSize(videoW, videoH);
    if (
      frameCanvas.width !== sized.width ||
      frameCanvas.height !== sized.height
    ) {
      frameCanvas.width = sized.width;
      frameCanvas.height = sized.height;
    }
    frameW = sized.width;
    frameH = sized.height;
    busy = true;
    frameCtx.drawImage(video, 0, 0, frameW, frameH);
    // Captured with the frame, not after inference: heading changes faster than GPS.
    const orientation = compass?.getReading() ?? null;
    const rawGps = gps?.getFix() ?? null;
    const { fix: gpsNow, gpsQuality } = resolveGpsForLog(rawGps);
    // A frame grabbed before the log is cleared is not logged after it.
    const generation = logGeneration;

    const { parameters, minConfidence } = getSettings();
    const confidenceFloor = Number(minConfidence ?? parameters.confidence) || 0.2;
    const madThreshold =
      STILL_SENSITIVITY[parameters.stillSensitivity] ?? STILL_SENSITIVITY.medium;
    const thumb = grabGrayscaleThumbnail(frameCanvas, thumbBuffer);
    const now = Date.now();
    const sceneDiff = meanAbsDiff(thumb, lastLogThumb);
    const movedM = distanceMeters(gpsNow, lastLogGps);
    const isStill =
      lastLogThumb != null &&
      sceneDiff < madThreshold &&
      movedM < STILL_MOVE_M;
    const needsHeartbeat =
      lastLogAt === 0 || now - lastLogAt >= HEARTBEAT_MS;

    if (isStill && parameters.skipWhenStill && !needsHeartbeat) {
      setStillPaused(true);
      lastCompletedInferenceAt = performance.now();
      busy = false;
      return;
    }
    setStillPaused(false);

    const t0 = performance.now();
    const task = getModelTask();
    const input = canvasToPipelineInput(frameCanvas);

    try {
      if (task === "classification") {
        const predictions = (
          await classifyImageFromSource(input, { topK: 3 })
        ).filter((item) => item.score >= confidenceFloor);
        const inferenceMs = performance.now() - t0;
        lastCompletedInferenceAt = performance.now();
        console.log(`[TIMING] live: ${inferenceMs.toFixed(0)}ms`);
        metrics.recordInferenceMs(inferenceMs);
        mediaWrap.querySelector(".bounding-boxes")?.remove();
        renderClassificationReadout(predictions);

        const classDetections = predictions.map((item) => ({
          label: item.label,
          score: item.score,
          rank: item.rank,
          box: null,
        }));
        const classLogged = logDetectionsIfNeeded(classDetections, {
          thumb,
          gpsFix: gpsNow,
          orientation,
          inferenceMs,
          now,
          generation,
          isStill,
          needsHeartbeat,
          gpsQuality,
        });
        lastLiveDetections = classDetections;
        annotate?.noteLiveLabels(
          classDetections.map((item, index) => ({
            label: item.label,
            score: item.score,
            box: null,
            frameW,
            frameH,
            rowId: classLogged[index]?.id ?? null,
          })),
        );
        annotate?.setSuggestions(
          predictions.map((item) => ({ label: item.label, score: item.score })),
        );
        annotate?.setLiveAnnotateState({ orientation, gpsFix: gpsNow });
      } else {
        // MediaPipe / OIV7 need the canvas element; Transformers gets RawImage/data URL.
        const engine = getModelEngine();
        const detectionSource =
          engine === "mediapipe" || engine === "onnx" ? frameCanvas : input;
        const rawDetections = await detectObjectsFromSource(detectionSource, {
          threshold: confidenceFloor,
          maxObjects: parameters.maxObjects,
        });
        const inferenceMs = performance.now() - t0;
        lastCompletedInferenceAt = performance.now();
        console.log(`[TIMING] live: ${inferenceMs.toFixed(0)}ms`);
        metrics.recordInferenceMs(inferenceMs);
        const cameraHeading = orientation?.cameraHeading ?? null;
        const detections = rawDetections.map((detection) => {
          const bearing = objectBearing(detection.box, frameW, frameH, cameraHeading);
          const distance = estimateDistance(detection.label, detection.box, frameW, frameH);
          const estimate = projectPosition(gpsNow, bearing, distance, orientation);
          return {
            ...detection,
            bearing,
            distance,
            distanceMethod: distance == null ? null : DISTANCE_METHOD,
            estLat: estimate?.lat ?? null,
            estLon: estimate?.lon ?? null,
          };
        });
        lastLiveDetections = detections;
        renderClassificationReadout(null);
        renderBoundingBoxesOnContainer(mediaWrap, detections, frameCanvas, {
          onSelectLabel: (label, detection) => {
            selectLiveDetection(label, detection, now, gpsNow);
          },
        });
        const selected = annotate?.getSelectedLabel?.() ?? null;
        if (selected) {
          setSelectedBoundingBox(mediaWrap, selected);
        }

        const logged = logDetectionsIfNeeded(detections, {
          thumb,
          gpsFix: gpsNow,
          orientation,
          inferenceMs,
          now,
          generation,
          isStill,
          needsHeartbeat,
          gpsQuality,
        });
        annotate?.noteLiveLabels(
          detections.map((item, index) => ({
            label: item.label,
            score: item.score,
            box: item.box,
            frameW,
            frameH,
            rowId: logged[index]?.id ?? null,
          })),
        );
        annotate?.setSuggestions(
          detections.map((item) => ({ label: item.label, score: item.score })),
        );
        annotate?.setLiveAnnotateState({ orientation, gpsFix: gpsNow });
      }
      updateMetricsPanel();
    } catch (error) {
      console.error("[LIVE] detection failed:", error);
    } finally {
      busy = false;
    }
  }

  function loop() {
    if (!running) {
      return;
    }
    tick();
    animationFrameId = requestAnimationFrame(loop);
  }

  function startCompassTracker() {
    if (compass) {
      return;
    }
    setHeading(formatHeading(null, "waiting"));
    compass = createCompassTracker((reading) => {
      setHeading(formatHeading(reading, null, compass));
      annotate?.setLiveAnnotateState({ orientation: reading });
    });
    compass.start();
    // After 3s: absolute heading, relative-only, or truly no events.
    window.setTimeout(() => {
      if (!running || !compass || compass.getReading()?.heading != null) {
        return;
      }
      const status = compass.isRelativeOnly?.()
        ? "relative-only"
        : "no-events";
      setHeading(formatHeading(compass.getReading(), status, compass));
    }, 3000);
  }

  async function startLiveDetection() {
    if (running) {
      return;
    }
    // Must stay synchronous in the Start click (before any await) for iOS permission.
    const compassPermission = requestCompassPermission();

    liveToggle.disabled = true;
    setModelPickersDisabled(true);
    try {
      // Model before camera: building a GPU model while the camera is open can crash mobile Chrome.
      setModelLoading(getModelId());
      try {
        await loadModel(getActiveSlot());
      } finally {
        setModelLoading(null);
      }
      stream = await requestCameraStream();
      setLiveDetectionActive(true);
      backendInfo = await getObjectDetectorBackend();
      setMetric(
        "backend",
        `${backendInfo.device}${backendInfo.dtype ? ` · ${backendInfo.dtype}` : ""}`,
      );

      metrics.reset();
      lastCompletedInferenceAt = 0;
      resetStillState();
      ensureGps();
      updateMetricsPanel();

      headingText = null;
      setHeading(formatHeading(null, "waiting"));

      video.srcObject = stream;
      await video.play();
      running = true;
      sessionStartedAt = Date.now();
      if (recordArmed && !isRecording) {
        isRecording = true;
        recordingStartedAt = Date.now();
        resetRecordingPlaceLog();
        startRecording(getModelId());
      }
      updateControls();
      annotate?.setLiveAnnotateState({
        running: true,
        gpsFix,
        backend: backendInfo,
        captureFrame,
      });
      // Await after running=true (Android resolves immediately; must not race before running).
      const compassState = await compassPermission;
      if (!running) {
        return;
      }
      if (compassState === "denied") {
        setHeading(formatHeading(null, "denied"));
      } else if (
        compassState === "unavailable" &&
        typeof window.DeviceOrientationEvent === "undefined"
      ) {
        // Truly missing API only — missing requestPermission is normal on Android.
        setHeading(formatHeading(null, "unavailable"));
      } else {
        startCompassTracker();
      }
      console.log(
        `[LIVE] analysesPerSecond=${getSettings().analysesPerSecond} intervalMs=${inferenceIntervalMsFromSettings()}`,
      );
      syncLookControls();
      scheduleAutoLook();
      loop();
    } catch (error) {
      setLiveDetectionActive(false);
      stopStream();
      showCameraFeedback("Live detection could not start");
      console.error("[LIVE] start failed:", error);
    } finally {
      liveToggle.disabled = false;
      setModelPickersDisabled(false);
    }
  }

  function ensureGps() {
    if (gps) {
      return;
    }
    gps = createGpsTracker((fix) => {
      gpsFix = fix;
      updateMetricsPanel();
      annotate?.setLiveAnnotateState({ gpsFix: fix });
    });
    gps.start();
  }

  function setModelLoading(modelId) {
    const overlay = document.getElementById("model-loading");
    const label = overlay?.querySelector(".cam__loading-label");
    if (!overlay || !label) {
      return;
    }
    if (modelId) {
      label.textContent = `Loading ${friendlyModelLabel(modelId)}…`;
      overlay.hidden = false;
    } else {
      overlay.hidden = true;
    }
    updateSessionChrome();
  }

  function handleExport(exporter) {
    const recordingId = getSelectedRecordingId();
    const exportBackend = { ...(backendInfo ?? {}), model: getModelId() };
    if (exporter(exportBackend, recordingId)) {
      markRecordingsExported(recordingId);
    } else {
      showCameraFeedback("Nothing to export — no rows in this selection");
    }
  }

  // Also ends a recording in progress; Review refreshes through onLiveDetectionLogCleared.
  function clearRecordings() {
    const unexported = getUnexportedRecordingCount();
    if (unexported > 0) {
      const message =
        unexported === 1
          ? "1 recording hasn't been exported. Clear all recordings?"
          : `${unexported} recordings haven't been exported. Clear all recordings?`;
      if (!window.confirm(message)) {
        return;
      }
    }
    isRecording = false;
    logGeneration += 1;
    clearLiveDetectionLog();
    annotate?.resetLabels();
    resetStillState();
    updateControls();
    updateMetricsPanel();
  }
  function closeExportMenu() {
    exportMenu.hidden = true;
    exportButton.setAttribute("aria-expanded", "false");
  }

  function openExportMenu() {
    exportMenu.hidden = false;
    const rect = exportButton.getBoundingClientRect();
    const menuWidth = exportMenu.offsetWidth;
    const left = Math.max(8, Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - 8));
    exportMenu.style.top = `${rect.bottom + 6}px`;
    exportMenu.style.left = `${left}px`;
    exportButton.setAttribute("aria-expanded", "true");
  }

  liveToggle.addEventListener("click", () => {
    if (running) {
      stopLiveDetection();
    } else {
      startLiveDetection();
    }
  });
  mainStart.addEventListener("click", startLiveDetection);
  liveStartMobile?.addEventListener("click", startLiveDetection);
  liveStop?.addEventListener("click", () => {
    if (running) {
      stopLiveDetection();
    }
  });

  // Desktop header record button: only while running
  recordButton.addEventListener("click", () => {
    if (!running) {
      return;
    }
    isRecording = !isRecording;
    if (isRecording) {
      recordingStartedAt = Date.now();
      resetRecordingPlaceLog();
      startRecording(getModelId());
    } else {
      stopRecording();
    }
    recordArmed = isRecording;
    updateControls();
  });

  // Mobile record switches: can arm while idle, toggle while live
  function toggleMobileRecording() {
    if (running) {
      isRecording = !isRecording;
      if (isRecording) {
        recordingStartedAt = Date.now();
        resetRecordingPlaceLog();
        startRecording(getModelId());
      } else {
        stopRecording();
      }
      recordArmed = isRecording;
    } else {
      recordArmed = !recordArmed;
    }
    updateControls();
  }

  for (const button of recordSwitches) {
    button.addEventListener("click", toggleMobileRecording);
  }

  clearButton.addEventListener("click", clearRecordings);
  copyCoordsBtn?.addEventListener("click", async () => {
    if (!gpsFix) {
      return;
    }
    const text = `${gpsFix.lat.toFixed(8)}, ${gpsFix.lon.toFixed(8)}`;
    try {
      await navigator.clipboard.writeText(text);
      copyCoordsBtn.textContent = "Copied";
      window.setTimeout(() => {
        copyCoordsBtn.textContent = "Copy";
      }, 1200);
    } catch {
      showCameraFeedback("Could not copy coordinates");
    }
  });
  exportButton.addEventListener("click", () => {
    if (exportMenu.hidden) {
      openExportMenu();
    } else {
      closeExportMenu();
    }
  });
  exportMenu.addEventListener("click", (event) => {
    const item = event.target.closest("[data-export]");
    if (!item) {
      return;
    }
    const exporter =
      item.dataset.export === "json"
        ? exportLiveDetectionJson
        : exportLiveDetectionCsv;
    closeExportMenu();
    handleExport(exporter);
  });
  document.addEventListener("click", (event) => {
    if (exportMenu.hidden) {
      return;
    }
    if (
      exportButton.contains(event.target) ||
      exportMenu.contains(event.target)
    ) {
      return;
    }
    closeExportMenu();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !exportMenu.hidden) {
      closeExportMenu();
      exportButton.focus();
    }
  });
  window.addEventListener("pagehide", () => {
    stopLiveDetection();
    gps?.stop();
    gps = null;
  });

  async function handleModelSelect(modelId) {
    const wasRunning = running;
    switchingModel = true;
    setModelLoading(modelId);
    setModelPickersDisabled(true);
    updateControls();
    try {
      while (busy) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      if (frozenLook) {
        resumeFromLook();
      }
      await setDetectionModel(modelId);
      syncNoiseSettingsUi(modelId);
      syncGeminiSettingsVisibility(modelId);
      backendInfo = await getObjectDetectorBackend();
      setMetric(
        "backend",
        `${backendInfo.device}${backendInfo.dtype ? ` · ${backendInfo.dtype}` : ""}`,
      );
      mediaWrap.querySelector(".bounding-boxes")?.remove();
      renderClassificationReadout(null);
      annotate?.setSuggestions([]);
      annotate?.setLiveAnnotateState({ backend: backendInfo });
      if (wasRunning) {
        showCameraFeedback(`Switched to ${friendlyModelLabel(modelId)}`);
      }
      scheduleAutoLook();
    } catch (error) {
      console.error("[LIVE] model switch failed:", error);
      showCameraFeedback("Could not load that model");
      syncModelPickers();
    } finally {
      switchingModel = false;
      setModelLoading(null);
      setModelPickersDisabled(false);
      updateControls();
      updateMetricsPanel();
    }
  }

  initModelPicker(handleModelSelect);
  initModelsSheet({
    getModels: () => MODEL_OPTIONS,
    getSelectedId: getModelId,
    onSelect: (modelId) => {
      syncModelPickers(modelId);
      handleModelSelect(modelId);
    },
  });
  initStillSettings();
  initGeminiSettings();
  for (const button of lookButtons) {
    button.addEventListener("click", () => {
      void runGeminiLook();
    });
  }
  for (const button of resumeButtons) {
    button.addEventListener("click", resumeFromLook);
  }
  for (const button of lookCancelButtons) {
    button.addEventListener("click", cancelGeminiLook);
  }
  for (const select of document.querySelectorAll(
    "#setting-gemini-auto-look, #setting-gemini-auto-look-mobile",
  )) {
    select.addEventListener("change", () => scheduleAutoLook());
  }
  ensureGps();
  setHeading(formatHeading(null, "waiting"));
  annotate?.setLiveAnnotateState({
    captureFrame,
    gpsFix,
    onSelectionChange: (label) => setSelectedBoundingBox(mediaWrap, label),
  });
  updateControls();
  updateMetricsPanel();
  syncGeminiSettingsVisibility();
  uiTimerId = window.setInterval(tickUiClocks, 1000);
}
