// Live page: camera loop, stats, recording toggle, and export buttons.
// Detection goes through objects.js / models.js; GPS, compass, and the log live in geolocation.js, compass.js, and detection-log.js.
import { RawImage } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.2.1";
import { requestCameraStream, showCameraFeedback } from "../utils/camera.js";
import {
  getActiveSlot,
  getModelId,
  getModelTask,
  getObjectDetectorBackend,
  loadModel,
  MODEL_OPTIONS,
  setDetectionModel,
  setLiveDetectionActive,
} from "../models.js";
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
} from "../analysis/objects.js";
import { classifyImageFromSource } from "../analysis/classify.js";
import {
  getSettings,
  initModelPicker,
  setModelPickersDisabled,
  syncModelPickers,
} from "./sidebar.js";
import { getSelectedRecordingId } from "./app-mode.js";

const ROLLING_WINDOW = 30;
// Cap the longest edge at 640px so full-resolution camera frames don't exhaust memory on mobile Safari.
const MAX_INFERENCE_EDGE = 640;

// Coarse-pointer devices (iPad etc.) wait ~700ms between completed inferences so memory can release; desktop stays 0.
function resolveInferenceIntervalMs() {
  const coarsePointer =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(pointer: coarse)").matches;
  return coarsePointer ? 700 : 0;
}

const INFERENCE_INTERVAL_MS = resolveInferenceIntervalMs();

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

function formatGpsFix(fix) {
  if (!fix) {
    return "—";
  }
  return `${fix.lat.toFixed(8)}, ${fix.lon.toFixed(8)}\n${formatGpsAccuracy(fix)}`;
}

// TEMPORARY field-test display: corrected camera heading, plus the raw inputs it came from.
function formatHeading(reading) {
  if (reading?.heading == null) {
    return { main: "No compass", detail: "" };
  }
  const degrees = (value) => `${Math.round(value) % 360}°`;
  const camera =
    reading.cameraHeading == null ? "—" : degrees(reading.cameraHeading);
  const accuracy =
    reading.accuracy == null ? "" : ` (±${Math.round(reading.accuracy)}°)`;
  const screenAngle =
    reading.screenAngle == null ? "—" : `${reading.screenAngle}°`;
  return {
    main: `${camera}${accuracy}`,
    detail: `raw ${degrees(reading.heading)}, screen ${screenAngle}`,
  };
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

export function initLiveDetectionPage() {
  const video = document.getElementById("live-video");
  const feed = document.getElementById("live-feed");
  const idle = document.getElementById("live-idle");
  const mediaWrap = document.querySelector(".live-stage__media");
  const liveToggle = document.getElementById("btn-live-toggle");
  const mainStart = document.getElementById("btn-live-start-main");
  const recordButton = document.getElementById("btn-record");
  const exportButton = document.getElementById("btn-export");
  const exportMenu = document.getElementById("export-menu");
  const clearButton = document.getElementById("btn-clear-recordings");

  if (
    !video ||
    !feed ||
    !idle ||
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

  const metrics = createLiveMetricsTracker();
  const frameCanvas = document.createElement("canvas");
  const frameCtx = frameCanvas.getContext("2d", { willReadFrequently: true });
  const canvasToPipelineInput = createPipelineInputHelper(frameCtx);

  let stream = null;
  let gps = null;
  let gpsFix = null;
  let compass = null;
  let headingText = null;
  let backendInfo = null;
  let running = false;
  let busy = false;
  let switchingModel = false;
  let isRecording = false;
  let animationFrameId = null;
  let lastCompletedInferenceAt = 0;
  let frameW = 0;
  let frameH = 0;
  let logGeneration = 0;

  // A metric can appear in both the sidebar and the phone status strip.
  function setMetric(name, value) {
    for (const target of document.querySelectorAll(`[data-metric="${name}"]`)) {
      target.textContent = value;
    }
  }

  function setHeading({ main, detail }) {
    const text = `${main}\n${detail}`;
    if (text === headingText) {
      return;
    }
    headingText = text;
    setMetric("heading", main);
    setMetric("heading-detail", detail);
  }

  function updateMetricsPanel() {
    const snapshot = metrics.getSnapshot();
    setMetric("instant", formatMetricMs(snapshot.instantMs));
    setMetric("avg", formatMetricMs(snapshot.rollingAvgMs));
    setMetric("fps", formatMetricFps(snapshot.effectiveFps));
    setMetric("frames", String(snapshot.frameCount));
    setMetric("gps", formatGpsFix(gpsFix));
    setMetric("gps-accuracy", formatGpsAccuracy(gpsFix));
    setMetric("logged", String(getLiveDetectionLogCount()));
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

  function updateControls() {
    liveToggle.textContent = running
      ? "Stop Live Detection"
      : "Start Live Detection";
    liveToggle.setAttribute("aria-pressed", String(running));
    recordButton.disabled = !running;
    recordButton.textContent = isRecording
      ? "Stop Recording"
      : "Start Recording";
    recordButton.setAttribute("aria-pressed", String(isRecording));
    recordButton.classList.toggle("btn--record-active", isRecording);
    feed.hidden = !running;
    idle.hidden = running;
    clearButton.disabled = getRecordings().length === 0;
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
    if (isRecording) {
      stopRecording();
    }
    isRecording = false;
    setLiveDetectionActive(false);
    gps?.stop();
    gps = null;
    compass?.stop();
    compass = null;
    if (animationFrameId !== null) {
      cancelAnimationFrame(animationFrameId);
      animationFrameId = null;
    }
    stopStream();
    mediaWrap.querySelector(".bounding-boxes")?.remove();
    renderClassificationReadout(null);
    updateControls();
  }

  async function tick() {
    // Single-in-flight: never start a new inference while one is running, so frames cannot pile up.
    if (!running || busy || switchingModel) {
      return;
    }
    // Throttle from last *completed* inference, not last tick, so a slow frame still gets breathing room.
    if (
      INFERENCE_INTERVAL_MS > 0 &&
      performance.now() - lastCompletedInferenceAt < INFERENCE_INTERVAL_MS
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
    // A frame grabbed before the log is cleared is not logged after it.
    const generation = logGeneration;

    const { parameters } = getSettings();
    const t0 = performance.now();
    const task = getModelTask();
    const input = canvasToPipelineInput(frameCanvas);

    try {
      if (task === "classification") {
        const predictions = await classifyImageFromSource(input, { topK: 3 });
        const inferenceMs = performance.now() - t0;
        lastCompletedInferenceAt = performance.now();
        console.log(`[TIMING] live: ${inferenceMs.toFixed(0)}ms`);
        metrics.recordInferenceMs(inferenceMs);
        mediaWrap.querySelector(".bounding-boxes")?.remove();
        renderClassificationReadout(predictions);

        if (isRecording && generation === logGeneration) {
          logDetectionFrame({
            detections: predictions.map((item) => ({
              label: item.label,
              score: item.score,
              rank: item.rank,
              box: null,
            })),
            frameW,
            frameH,
            inferenceMs,
            timestamp: Date.now(),
            gpsFix: gps?.getFix() ?? null,
            orientation,
            backend: backendInfo,
            modelId: getModelId(),
          });
        }
      } else {
        const rawDetections = await detectObjectsFromSource(input, {
          threshold: parameters.confidence,
          maxObjects: parameters.maxObjects,
        });
        const inferenceMs = performance.now() - t0;
        lastCompletedInferenceAt = performance.now();
        console.log(`[TIMING] live: ${inferenceMs.toFixed(0)}ms`);
        metrics.recordInferenceMs(inferenceMs);
        const cameraHeading = orientation?.cameraHeading ?? null;
        const gpsFix = gps?.getFix() ?? null;
        const detections = rawDetections.map((detection) => {
          const bearing = objectBearing(detection.box, frameW, frameH, cameraHeading);
          const distance = estimateDistance(detection.label, detection.box, frameW, frameH);
          const estimate = projectPosition(gpsFix, bearing, distance, orientation);
          return {
            ...detection,
            bearing,
            distance,
            distanceMethod: distance == null ? null : DISTANCE_METHOD,
            estLat: estimate?.lat ?? null,
            estLon: estimate?.lon ?? null,
          };
        });
        renderClassificationReadout(null);
        renderBoundingBoxesOnContainer(mediaWrap, detections, frameCanvas);

        if (isRecording && generation === logGeneration) {
          logDetectionFrame({
            detections,
            frameW,
            frameH,
            inferenceMs,
            timestamp: Date.now(),
            gpsFix,
            orientation,
            backend: backendInfo,
            modelId: getModelId(),
          });
        }
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

  async function startLiveDetection() {
    if (running) {
      return;
    }
    const compassPermission = requestCompassPermission();

    liveToggle.disabled = true;
    mainStart.disabled = true;
    setModelPickersDisabled(true);
    try {
      stream = await requestCameraStream();
      setLiveDetectionActive(true);
      await loadModel(getActiveSlot());
      backendInfo = await getObjectDetectorBackend();
      setMetric("backend", `${backendInfo.device} · ${backendInfo.dtype}`);

      metrics.reset();
      gpsFix = null;
      lastCompletedInferenceAt = 0;
      updateMetricsPanel();

      gps = createGpsTracker((fix) => {
        gpsFix = fix;
        updateMetricsPanel();
      });
      gps.start();

      headingText = null;
      setHeading(formatHeading(null));

      video.srcObject = stream;
      await video.play();
      running = true;
      updateControls();
      compassPermission.then((state) => {
        if (state !== "granted" || !running || compass) {
          return;
        }
        compass = createCompassTracker((reading) =>
          setHeading(formatHeading(reading)),
        );
        compass.start();
      });
      console.log(`[LIVE] INFERENCE_INTERVAL_MS=${INFERENCE_INTERVAL_MS}`);
      loop();
    } catch (error) {
      setLiveDetectionActive(false);
      stopStream();
      showCameraFeedback("Live detection could not start");
      console.error("[LIVE] start failed:", error);
    } finally {
      liveToggle.disabled = false;
      mainStart.disabled = false;
      setModelPickersDisabled(false);
    }
  }

  function setModelLoading(modelId) {
    const overlay = document.getElementById("model-loading");
    const label = overlay?.querySelector(".live-stage__loading-label");
    if (!overlay || !label) {
      return;
    }
    if (modelId) {
      label.textContent = `Loading ${friendlyModelLabel(modelId)}…`;
      overlay.hidden = false;
    } else {
      overlay.hidden = true;
    }
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
  recordButton.addEventListener("click", () => {
    if (!running) {
      return;
    }
    isRecording = !isRecording;
    if (isRecording) {
      startRecording(getModelId());
    } else {
      stopRecording();
    }
    updateControls();
  });
  clearButton.addEventListener("click", clearRecordings);
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
  window.addEventListener("pagehide", stopLiveDetection);

  async function handleModelSelect(modelId) {
    switchingModel = true;
    setModelLoading(modelId);
    setModelPickersDisabled(true);
    try {
      while (busy) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      await setDetectionModel(modelId);
      backendInfo = await getObjectDetectorBackend();
      setMetric("backend", `${backendInfo.device} · ${backendInfo.dtype}`);
      mediaWrap.querySelector(".bounding-boxes")?.remove();
      renderClassificationReadout(null);
    } catch (error) {
      console.error("[LIVE] model switch failed:", error);
      showCameraFeedback("Could not load that model");
      syncModelPickers();
    } finally {
      switchingModel = false;
      setModelLoading(null);
      setModelPickersDisabled(false);
    }
  }

  initModelPicker(handleModelSelect);
  updateControls();
  updateMetricsPanel();
}
