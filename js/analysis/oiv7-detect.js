// YOLOv8n Open Images V7 (601 classes) via onnxruntime-web — WebGPU with WASM fallback.
const ORT_VERSION = "1.21.0";
const ORT_CDN = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}`;
const ORT_MODULE = `${ORT_CDN}/dist/ort.webgpu.min.mjs`;

// 416 is the default (phone); 640 remains available as an optional asset.
const MODEL_416 = "models/oiv7/yolov8n-oiv7-416.onnx";
const CLASSES_URL = "models/oiv7/oiv7-classes.json";

const INPUT_SIZE = 416;
const SCORE_FLOOR = 0.25;
const NMS_IOU = 0.45;
const MAX_BOXES = 20;
const LETTERBOX_FILL = 114;

let ort = null;
let session = null;
let classNames = null;
let backend = { device: "wasm", dtype: "fp32" };
let letterboxCanvas = null;
let letterboxCtx = null;

async function loadOrt() {
  if (ort) {
    return ort;
  }
  ort = await import(ORT_MODULE);
  ort.env.wasm.wasmPaths = `${ORT_CDN}/dist/`;
  return ort;
}

async function loadClassNames() {
  if (classNames) {
    return classNames;
  }
  const response = await fetch(CLASSES_URL);
  if (!response.ok) {
    throw new Error(`Failed to load OIV7 classes (${response.status})`);
  }
  classNames = await response.json();
  return classNames;
}

async function createSession(executionProviders) {
  const runtime = await loadOrt();
  return runtime.InferenceSession.create(MODEL_416, {
    executionProviders,
    graphOptimizationLevel: "all",
  });
}

export function getOiv7Backend() {
  return { ...backend };
}

export async function loadOiv7ObjectDetector() {
  if (session) {
    return session;
  }

  await loadClassNames();
  await loadOrt();

  try {
    session = await createSession(["webgpu", "wasm"]);
    backend = { device: "webgpu", dtype: "fp32" };
    console.log("[OIV7] session ready (webgpu→wasm)", { inputSize: INPUT_SIZE });
  } catch (error) {
    console.log("[OIV7] WebGPU path failed → wasm", error?.message ?? error);
    session = await createSession(["wasm"]);
    backend = { device: "wasm", dtype: "fp32" };
    console.log("[OIV7] session ready (wasm)", { inputSize: INPUT_SIZE });
  }

  return session;
}

export function disposeOiv7ObjectDetector() {
  if (!session) {
    return;
  }
  try {
    session.release?.();
  } catch {
    // Best-effort.
  }
  session = null;
}

function ensureLetterboxCanvas(size) {
  if (!letterboxCanvas || letterboxCanvas.width !== size) {
    letterboxCanvas = document.createElement("canvas");
    letterboxCanvas.width = size;
    letterboxCanvas.height = size;
    letterboxCtx = letterboxCanvas.getContext("2d", { willReadFrequently: true });
  }
  return { canvas: letterboxCanvas, ctx: letterboxCtx };
}

// Letterbox source into size×size with gray pad; return scale + pads for unmapping.
function letterboxDraw(source, size) {
  const srcW = source.videoWidth || source.naturalWidth || source.width;
  const srcH = source.videoHeight || source.naturalHeight || source.height;
  if (!srcW || !srcH) {
    return null;
  }

  const scale = Math.min(size / srcW, size / srcH);
  const newW = Math.round(srcW * scale);
  const newH = Math.round(srcH * scale);
  const padX = (size - newW) / 2;
  const padY = (size - newH) / 2;

  const { canvas, ctx } = ensureLetterboxCanvas(size);
  ctx.fillStyle = `rgb(${LETTERBOX_FILL},${LETTERBOX_FILL},${LETTERBOX_FILL})`;
  ctx.fillRect(0, 0, size, size);
  ctx.drawImage(source, padX, padY, newW, newH);

  return { canvas, srcW, srcH, scale, padX, padY };
}

function canvasToNchwFloat32(canvas) {
  const { width, height } = canvas;
  const { data } = letterboxCtx.getImageData(0, 0, width, height);
  const plane = width * height;
  const tensor = new Float32Array(3 * plane);
  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    tensor[p] = data[i] / 255;
    tensor[p + plane] = data[i + 1] / 255;
    tensor[p + 2 * plane] = data[i + 2] / 255;
  }
  return tensor;
}

function iou(a, b) {
  const x1 = Math.max(a.xmin, b.xmin);
  const y1 = Math.max(a.ymin, b.ymin);
  const x2 = Math.min(a.xmax, b.xmax);
  const y2 = Math.min(a.ymax, b.ymax);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const areaA = Math.max(0, a.xmax - a.xmin) * Math.max(0, a.ymax - a.ymin);
  const areaB = Math.max(0, b.xmax - b.xmin) * Math.max(0, b.ymax - b.ymin);
  const union = areaA + areaB - inter;
  return union <= 0 ? 0 : inter / union;
}

function nms(candidates, iouThresh, maxBoxes) {
  const sorted = candidates.slice().sort((a, b) => b.score - a.score);
  const kept = [];
  for (const box of sorted) {
    let ok = true;
    for (const prior of kept) {
      if (iou(box, prior) >= iouThresh) {
        ok = false;
        break;
      }
    }
    if (ok) {
      kept.push(box);
      if (kept.length >= maxBoxes) {
        break;
      }
    }
  }
  return kept;
}

function parseOutput(output, meta, { threshold, maxObjects }) {
  // Expected: [1, 605, N] — 4 box + 601 class scores, no objectness.
  const dims = output.dims ?? output.dimensions;
  const data = output.data;
  if (!dims || dims.length < 3 || !data) {
    return [];
  }

  const channels = dims[1];
  const anchors = dims[2];
  const numClasses = channels - 4;
  if (numClasses <= 0 || anchors <= 0) {
    return [];
  }

  const floor = Math.max(SCORE_FLOOR, Number(threshold) || SCORE_FLOOR);
  const limit = Math.min(MAX_BOXES, Math.max(1, Number(maxObjects) || MAX_BOXES));
  const names = classNames ?? [];
  const { scale, padX, padY, srcW, srcH } = meta;

  const candidates = [];
  for (let i = 0; i < anchors; i += 1) {
    let bestScore = -1;
    let bestClass = -1;
    for (let c = 0; c < numClasses; c += 1) {
      const score = data[(4 + c) * anchors + i];
      if (score > bestScore) {
        bestScore = score;
        bestClass = c;
      }
    }
    if (bestScore < floor || bestClass < 0) {
      continue;
    }

    const cx = data[0 * anchors + i];
    const cy = data[1 * anchors + i];
    const w = data[2 * anchors + i];
    const h = data[3 * anchors + i];

    const xminIn = cx - w / 2;
    const yminIn = cy - h / 2;
    const xmaxIn = cx + w / 2;
    const ymaxIn = cy + h / 2;

    const xmin = Math.max(0, Math.min(srcW, (xminIn - padX) / scale));
    const ymin = Math.max(0, Math.min(srcH, (yminIn - padY) / scale));
    const xmax = Math.max(0, Math.min(srcW, (xmaxIn - padX) / scale));
    const ymax = Math.max(0, Math.min(srcH, (ymaxIn - padY) / scale));
    if (xmax <= xmin || ymax <= ymin) {
      continue;
    }

    candidates.push({
      label: names[bestClass] || `class_${bestClass}`,
      score: bestScore,
      xmin,
      ymin,
      xmax,
      ymax,
    });
  }

  return nms(candidates, NMS_IOU, limit).map((item) => ({
    label: item.label,
    score: item.score,
    box: {
      xmin: item.xmin,
      ymin: item.ymin,
      xmax: item.xmax,
      ymax: item.ymax,
    },
  }));
}

export async function detectObjectsWithOiv7(source, options) {
  const { threshold, maxObjects } = options;
  await loadOiv7ObjectDetector();
  if (!session) {
    return [];
  }

  const meta = letterboxDraw(source, INPUT_SIZE);
  if (!meta) {
    return [];
  }

  const runtime = await loadOrt();
  const tensor = new runtime.Tensor(
    "float32",
    canvasToNchwFloat32(meta.canvas),
    [1, 3, INPUT_SIZE, INPUT_SIZE],
  );

  const feeds = {};
  const inputName = session.inputNames?.[0] ?? "images";
  feeds[inputName] = tensor;

  const results = await session.run(feeds);
  const outputName = session.outputNames?.[0] ?? "output0";
  const output = results[outputName];
  return parseOutput(output, meta, { threshold, maxObjects });
}
