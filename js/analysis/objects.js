// Runs the object detector from models.js and draws label/confidence boxes on the live feed.
import { getModel, getModelEngine, loadModel } from "../models.js";
import { detectObjectsWithMediaPipe } from "./mediapipe-detect.js";

const LABEL_COLORS = [
  "#e6194b",
  "#3cb44b",
  "#4363d8",
  "#f58231",
  "#911eb4",
  "#42d4f4",
  "#f032e6",
  "#469990",
  "#9a6324",
  "#800000",
  "#808000",
  "#000075",
];

const labelColorCache = new Map();

function hashLabel(label) {
  let hash = 0;

  for (let i = 0; i < label.length; i += 1) {
    hash = (hash << 5) - hash + label.charCodeAt(i);
    hash |= 0;
  }

  return Math.abs(hash);
}

function getLabelColor(label) {
  if (!labelColorCache.has(label)) {
    const index = hashLabel(label) % LABEL_COLORS.length;
    labelColorCache.set(label, LABEL_COLORS[index]);
  }

  return labelColorCache.get(label);
}

function normalizeScore(score) {
  const value = Number(score);
  return Number.isFinite(value) ? value : 0;
}

function formatObjectScore(score) {
  return normalizeScore(score).toFixed(2);
}

// Map boxes onto the visible object-fit content rect (contain letterboxing / cover cropping).
function getObjectFitContentRect(element, container) {
  const containerRect = container.getBoundingClientRect();
  const mediaW =
    element.videoWidth || element.naturalWidth || element.width || 0;
  const mediaH =
    element.videoHeight || element.naturalHeight || element.height || 0;
  const containerW = containerRect.width;
  const containerH = containerRect.height;
  if (!mediaW || !mediaH || !containerW || !containerH) {
    return { left: 0, top: 0, width: containerW, height: containerH };
  }

  const fit = getComputedStyle(element).objectFit || "fill";
  const mediaRatio = mediaW / mediaH;
  const containerRatio = containerW / containerH;
  let width = containerW;
  let height = containerH;
  let left = 0;
  let top = 0;

  if (fit === "contain") {
    if (mediaRatio > containerRatio) {
      width = containerW;
      height = containerW / mediaRatio;
      top = (containerH - height) / 2;
    } else {
      height = containerH;
      width = containerH * mediaRatio;
      left = (containerW - width) / 2;
    }
  } else if (fit === "cover") {
    if (mediaRatio > containerRatio) {
      height = containerH;
      width = containerH * mediaRatio;
      left = (containerW - width) / 2;
    } else {
      width = containerW;
      height = containerW / mediaRatio;
      top = (containerH - height) / 2;
    }
  }

  return { left, top, width, height };
}

function drawBoundingBoxes(container, results, dimensionSource) {
  const image = dimensionSource ?? container.querySelector("img");
  if (!image || !results?.length) {
    return;
  }

  const existingLayer = container.querySelector(".bounding-boxes");
  if (existingLayer) {
    existingLayer.remove();
  }

  const layer = document.createElement("div");
  layer.className = "bounding-boxes";
  const content = getObjectFitContentRect(image, container);
  layer.style.left = `${content.left}px`;
  layer.style.top = `${content.top}px`;
  layer.style.width = `${content.width}px`;
  layer.style.height = `${content.height}px`;
  layer.style.right = "auto";
  layer.style.bottom = "auto";

  for (const result of results) {
    const percentBox = boxToPercentages(result.box, image);
    if (!percentBox) {
      continue;
    }

    const color = getLabelColor(result.label);
    const isPerson = result.label.toLowerCase() === "person";
    const boxEl = document.createElement("div");
    boxEl.className = "bounding-box";
    if (isPerson) {
      boxEl.classList.add("bounding-box--person");
    }
    boxEl.style.left = `${percentBox.left}%`;
    boxEl.style.top = `${percentBox.top}%`;
    boxEl.style.width = `${percentBox.width}%`;
    boxEl.style.height = `${percentBox.height}%`;
    boxEl.style.borderColor = color;

    const labelEl = document.createElement("span");
    labelEl.className = "bounding-box__label";
    // TEMPORARY field-test readout: bearing appended to the label.
    const bearing = Number.isFinite(result.bearing)
      ? ` · ${Math.round(result.bearing) % 360}°`
      : "";
    const scoreText =
      result.score == null || Number.isNaN(Number(result.score))
        ? ""
        : ` ${formatObjectScore(result.score)}`;
    labelEl.textContent = `${result.label}${scoreText}${bearing}`;
    labelEl.style.backgroundColor = color;

    boxEl.dataset.label = result.label;
    boxEl.setAttribute("role", "button");
    boxEl.tabIndex = 0;
    boxEl.setAttribute("aria-pressed", "false");
    if (result.selected) {
      boxEl.classList.add("bounding-box--selected");
      boxEl.setAttribute("aria-pressed", "true");
    }

    boxEl.appendChild(labelEl);
    layer.appendChild(boxEl);
  }

  container.appendChild(layer);
}

export function renderBoundingBoxesOnContainer(
  container,
  results,
  dimensionSource,
  { onSelectLabel } = {},
) {
  const image = dimensionSource ?? container.querySelector("img");
  if (!image) {
    return;
  }

  const existingLayer = container.querySelector(".bounding-boxes");
  if (!results?.length) {
    existingLayer?.remove();
    return;
  }

  drawBoundingBoxes(container, results, dimensionSource);

  const layer = container.querySelector(".bounding-boxes");
  if (!layer) {
    return;
  }
  if (typeof onSelectLabel === "function") {
    layer.classList.add("is-interactive");
    layer.addEventListener("click", (event) => {
      const box = event.target.closest(".bounding-box[data-label]");
      if (!box) {
        return;
      }
      event.preventDefault();
      onSelectLabel(box.dataset.label);
    });
  }
}

export function setSelectedBoundingBox(container, label) {
  const layer = container?.querySelector(".bounding-boxes");
  if (!layer) {
    return;
  }
  for (const box of layer.querySelectorAll(".bounding-box")) {
    const selected = label != null && box.dataset.label === label;
    box.classList.toggle("bounding-box--selected", selected);
    box.setAttribute("aria-pressed", String(selected));
  }
}

function boxToPercentages(box, image) {
  const width = image.videoWidth || image.naturalWidth || image.width;
  const height = image.videoHeight || image.naturalHeight || image.height;

  if (!width || !height) {
    return null;
  }

  const isNormalized =
    box.xmin >= 0 &&
    box.ymin >= 0 &&
    box.xmax <= 1 &&
    box.ymax <= 1;

  if (isNormalized) {
    return {
      left: box.xmin * 100,
      top: box.ymin * 100,
      width: (box.xmax - box.xmin) * 100,
      height: (box.ymax - box.ymin) * 100,
    };
  }

  return {
    left: (box.xmin / width) * 100,
    top: (box.ymin / height) * 100,
    width: ((box.xmax - box.xmin) / width) * 100,
    height: ((box.ymax - box.ymin) / height) * 100,
  };
}

export async function detectObjectsFromSource(source, options) {
  const { threshold, maxObjects } = options;

  if (getModelEngine() === "mediapipe") {
    // MediaPipe expects a canvas / video / image element (not Transformers RawImage).
    return detectObjectsWithMediaPipe(source, { threshold, maxObjects });
  }

  await loadModel("objectDetector");
  const model = getModel("objectDetector");

  const rawResults = await model(source, { threshold });

  return rawResults.slice(0, maxObjects).map((item) => ({
    label: item.label,
    score: normalizeScore(item.score),
    box: {
      xmin: item.box.xmin,
      ymin: item.box.ymin,
      xmax: item.box.xmax,
      ymax: item.box.ymax,
    },
  }));
}
