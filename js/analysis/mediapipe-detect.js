// MediaPipe Tasks Vision ObjectDetector (EfficientDet-Lite0) — separate from Transformers.js.
const TASKS_VISION_VERSION = "0.10.32";
const VISION_BUNDLE_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VISION_VERSION}/vision_bundle.mjs`;
const WASM_ROOT = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VISION_VERSION}/wasm`;
// Official Google-hosted EfficientDet-Lite0 (float16).
export const MEDIAPIPE_EFFICIENTDET_LITE0_URL =
  "https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite";

let detector = null;
let delegate = "GPU";

function normalizeScore(score) {
  const value = Number(score);
  return Number.isFinite(value) ? value : 0;
}

async function createDetector(chosenDelegate) {
  const { FilesetResolver, ObjectDetector } = await import(VISION_BUNDLE_URL);
  const vision = await FilesetResolver.forVisionTasks(WASM_ROOT);
  return ObjectDetector.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: MEDIAPIPE_EFFICIENTDET_LITE0_URL,
      delegate: chosenDelegate,
    },
    // Low floor here; live settings apply a per-model confidence filter afterward.
    runningMode: "IMAGE",
    scoreThreshold: 0.05,
    maxResults: 25,
  });
}

export function getMediaPipeBackend() {
  return { device: "mediapipe", dtype: delegate === "GPU" ? "gpu" : "cpu" };
}

export async function loadMediaPipeObjectDetector() {
  if (detector) {
    return detector;
  }

  try {
    detector = await createDetector("GPU");
    delegate = "GPU";
  } catch (error) {
    console.log(
      "[MEDIAPIPE] GPU delegate failed → CPU",
      error?.message ?? error,
    );
    detector = await createDetector("CPU");
    delegate = "CPU";
  }

  return detector;
}

export function disposeMediaPipeObjectDetector() {
  if (!detector) {
    return;
  }
  try {
    detector.close?.();
  } catch {
    // Best-effort.
  }
  detector = null;
}

export async function detectObjectsWithMediaPipe(source, options) {
  const { threshold, maxObjects } = options;
  await loadMediaPipeObjectDetector();
  if (!detector) {
    return [];
  }

  const result = detector.detect(source);
  const detections = result?.detections ?? [];
  const floor = Number(threshold) || 0;
  const limit = Math.max(1, Number(maxObjects) || 10);

  const mapped = [];
  for (const detection of detections) {
    const category = detection.categories?.[0];
    const box = detection.boundingBox;
    if (!category || !box) {
      continue;
    }
    const score = normalizeScore(category.score);
    if (score < floor) {
      continue;
    }
    const xmin = box.originX;
    const ymin = box.originY;
    mapped.push({
      label: category.categoryName || category.displayName || "object",
      score,
      box: {
        xmin,
        ymin,
        xmax: xmin + box.width,
        ymax: ymin + box.height,
      },
    });
    if (mapped.length >= limit) {
      break;
    }
  }
  return mapped;
}
