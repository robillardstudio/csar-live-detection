// Live-loop settings (rate / confidence / still skip) + model pickers — stored per model.
import { MODEL_OPTIONS, getModelId } from "../models.js";

const SENSITIVITY_LEVELS = ["low", "medium", "high"];
const RATE_OPTIONS = [0, 1, 2, 5, 10];
const STORAGE_KEY = "live-noise-by-model-v1";

const MOBILENET_DEFAULTS = {
  analysesPerSecond: 2,
  minConfidence: 0.2,
  skipWhenStill: true,
  stillSensitivity: "medium",
  maxObjects: 10,
};

// Pre–noise-limit detector behaviour: no analyses/sec cap (device throttle only),
// pipeline threshold 0.5, no skip-when-still.
const DETECTOR_DEFAULTS = {
  analysesPerSecond: 0,
  minConfidence: 0.5,
  skipWhenStill: false,
  stillSensitivity: "medium",
  maxObjects: 10,
};

/** @type {Record<string, typeof MOBILENET_DEFAULTS>} */
const byModel = Object.create(null);

function defaultsForModel(modelId) {
  const task =
    MODEL_OPTIONS.find((item) => item.id === modelId)?.task ?? "detection";
  return {
    ...(task === "classification" ? MOBILENET_DEFAULTS : DETECTOR_DEFAULTS),
  };
}

function loadStore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return;
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return;
    }
    for (const [id, value] of Object.entries(parsed)) {
      if (value && typeof value === "object") {
        byModel[id] = { ...defaultsForModel(id), ...value };
      }
    }
  } catch {
    // Ignore bad storage.
  }
}

function saveStore() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(byModel));
  } catch {
    // Quota / private mode.
  }
}

function ensureModel(modelId = getModelId()) {
  if (!byModel[modelId]) {
    byModel[modelId] = defaultsForModel(modelId);
  }
  return byModel[modelId];
}

loadStore();

export function getSettings() {
  const settings = ensureModel();
  return {
    analysisSettings: {},
    parameters: {
      confidence: settings.minConfidence,
      maxObjects: settings.maxObjects,
      skipWhenStill: settings.skipWhenStill,
      stillSensitivity: settings.stillSensitivity,
    },
    analysesPerSecond: settings.analysesPerSecond,
    minConfidence: settings.minConfidence,
  };
}

function clampConfidence(value) {
  return Math.min(0.9, Math.max(0.05, Number(value) || 0.2));
}

function clampRate(value) {
  const n = Number(value);
  return RATE_OPTIONS.includes(n) ? n : 2;
}

export function syncNoiseSettingsUi(modelId = getModelId()) {
  const settings = ensureModel(modelId);

  const rateSelects = [
    ...document.querySelectorAll("[data-noise-rate]"),
  ];
  for (const select of rateSelects) {
    select.value = String(settings.analysesPerSecond);
  }

  const confidenceInputs = [
    ...document.querySelectorAll("[data-noise-confidence]"),
  ];
  const confidenceLabels = [
    ...document.querySelectorAll("[data-noise-confidence-value]"),
  ];
  for (const input of confidenceInputs) {
    input.value = String(settings.minConfidence);
  }
  for (const label of confidenceLabels) {
    label.textContent = settings.minConfidence.toFixed(2);
  }

  const skips = [
    document.getElementById("skip-when-still"),
    document.getElementById("skip-when-still-mobile"),
  ].filter(Boolean);
  for (const skip of skips) {
    skip.checked = settings.skipWhenStill;
  }

  const sliders = [
    document.getElementById("still-sensitivity"),
    document.getElementById("still-sensitivity-mobile"),
  ].filter(Boolean);
  const labels = [
    document.getElementById("still-sensitivity-label"),
    document.getElementById("still-sensitivity-label-mobile"),
  ].filter(Boolean);
  const index = SENSITIVITY_LEVELS.indexOf(settings.stillSensitivity);
  const sliderValue = String(index < 0 ? 1 : index);
  for (const slider of sliders) {
    slider.value = sliderValue;
  }
  const level = SENSITIVITY_LEVELS[Number(sliderValue)] ?? "medium";
  const text = level.charAt(0).toUpperCase() + level.slice(1);
  for (const label of labels) {
    label.textContent = text;
  }
}

export function initStillSettings() {
  const rateSelects = [
    ...document.querySelectorAll("[data-noise-rate]"),
  ];
  const confidenceInputs = [
    ...document.querySelectorAll("[data-noise-confidence]"),
  ];
  const confidenceLabels = [
    ...document.querySelectorAll("[data-noise-confidence-value]"),
  ];
  const skips = [
    document.getElementById("skip-when-still"),
    document.getElementById("skip-when-still-mobile"),
  ].filter(Boolean);
  const sliders = [
    document.getElementById("still-sensitivity"),
    document.getElementById("still-sensitivity-mobile"),
  ].filter(Boolean);

  function patch(updater) {
    const settings = ensureModel();
    updater(settings);
    saveStore();
    syncNoiseSettingsUi();
  }

  for (const select of rateSelects) {
    select.addEventListener("change", () => {
      patch((settings) => {
        settings.analysesPerSecond = clampRate(select.value);
      });
    });
  }

  for (const input of confidenceInputs) {
    input.addEventListener("input", () => {
      patch((settings) => {
        settings.minConfidence = clampConfidence(input.value);
      });
    });
  }

  for (const skip of skips) {
    skip.addEventListener("change", () => {
      patch((settings) => {
        settings.skipWhenStill = skip.checked;
      });
    });
  }

  for (const slider of sliders) {
    slider.addEventListener("input", () => {
      patch((settings) => {
        settings.stillSensitivity =
          SENSITIVITY_LEVELS[Number(slider.value)] ?? "medium";
      });
    });
  }

  syncNoiseSettingsUi();
}

// Sidebar, start screen, and mobile session card share the same model pickers.
function getModelPickers() {
  return [...document.querySelectorAll("[data-model-picker]")];
}

export function syncModelPickers(modelId = getModelId()) {
  for (const select of getModelPickers()) {
    select.value = modelId;
  }
}

export function setModelPickersDisabled(disabled) {
  for (const select of getModelPickers()) {
    select.disabled = disabled;
  }
}

export function initModelPicker(onSelect) {
  const selects = getModelPickers();
  for (const select of selects) {
    select.replaceChildren();
    for (const option of MODEL_OPTIONS) {
      const el = document.createElement("option");
      el.value = option.id;
      el.textContent = option.label;
      el.disabled = !option.enabled;
      select.appendChild(el);
    }

    select.addEventListener("change", () => {
      const option = MODEL_OPTIONS.find((item) => item.id === select.value);
      if (!option?.enabled) {
        syncModelPickers();
        return;
      }
      syncModelPickers(select.value);
      syncNoiseSettingsUi(select.value);
      onSelect?.(select.value);
    });
  }
  syncModelPickers();
  syncNoiseSettingsUi();
  return selects;
}
