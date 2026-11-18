// Live-loop settings (rate / confidence / still skip) + model pickers — stored per model.
import { MODEL_OPTIONS, getModelId, getModelEngine } from "../models.js";
import {
  DEFAULT_GEMINI_MODEL,
  getGeminiApiKey,
  getGeminiModelId,
  setGeminiApiKey,
  setGeminiModelId,
} from "../live/gemini-settings.js";
import {
  clearGeminiModelCache,
  listDescriptionModels,
} from "../live/gemini-client.js";

const AUTO_LOOK_STORAGE = "live-detection.geminiAutoLookSec";
let autoLookSeconds = 0;

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

// YOLOv8n-OIV7: 5 analyses/s, score floor 0.25, NMS max 20.
const OIV7_DEFAULTS = {
  analysesPerSecond: 5,
  minConfidence: 0.25,
  skipWhenStill: false,
  stillSensitivity: "medium",
  maxObjects: 20,
};

/** @type {Record<string, typeof MOBILENET_DEFAULTS>} */
const byModel = Object.create(null);

function defaultsForModel(modelId) {
  if (modelId === "yolov8n-oiv7") {
    return { ...OIV7_DEFAULTS };
  }
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
      syncGeminiSettingsVisibility(select.value);
      onSelect?.(select.value);
    });
  }
  syncModelPickers();
  syncNoiseSettingsUi();
  return selects;
}

export function getGeminiAutoLookSeconds() {
  return autoLookSeconds;
}

export function syncGeminiSettingsVisibility(modelId = getModelId()) {
  const gemini = getModelEngine() === "gemini" || modelId === "gemini:boxes";
  for (const node of document.querySelectorAll(
    "#gemini-settings-desktop, #gemini-settings-mobile, #gemini-look-mobile",
  )) {
    node.hidden = !gemini;
  }
}

function showGeminiModelSelect(select, fallback) {
  select.hidden = false;
  fallback.hidden = true;
}

function showGeminiModelFallback(select, fallback) {
  select.hidden = true;
  fallback.hidden = false;
  fallback.value = getGeminiModelId() || DEFAULT_GEMINI_MODEL;
}

async function refreshGeminiModelPicker(select, fallback) {
  const key = getGeminiApiKey();
  if (!key) {
    showGeminiModelFallback(select, fallback);
    return;
  }
  try {
    const models = await listDescriptionModels(key);
    if (!models.length) {
      throw new Error("no_models");
    }
    const saved = getGeminiModelId() || DEFAULT_GEMINI_MODEL;
    select.replaceChildren();
    for (const model of models) {
      const option = document.createElement("option");
      option.value = model.id;
      option.textContent = model.label;
      select.appendChild(option);
    }
    if (models.some((model) => model.id === saved)) {
      select.value = saved;
    } else if (models.some((model) => model.id === DEFAULT_GEMINI_MODEL)) {
      select.value = DEFAULT_GEMINI_MODEL;
      setGeminiModelId(DEFAULT_GEMINI_MODEL);
    } else {
      select.value = models[0].id;
      setGeminiModelId(models[0].id);
    }
    showGeminiModelSelect(select, fallback);
  } catch (error) {
    console.error("[GEMINI] model list failed:", error?.message || error);
    showGeminiModelFallback(select, fallback);
  }
}

export function initGeminiSettings() {
  try {
    const saved = Number(localStorage.getItem(AUTO_LOOK_STORAGE));
    autoLookSeconds = [0, 5, 10, 20].includes(saved) ? saved : 0;
  } catch {
    autoLookSeconds = 0;
  }

  const keyInputs = [
    document.getElementById("setting-gemini-api-key"),
    document.getElementById("setting-gemini-api-key-mobile"),
  ].filter(Boolean);
  const modelSelects = [
    document.getElementById("setting-gemini-model"),
    document.getElementById("setting-gemini-model-mobile"),
  ].filter(Boolean);
  const modelFallbacks = [
    document.getElementById("setting-gemini-model-fallback"),
    document.getElementById("setting-gemini-model-fallback-mobile"),
  ].filter(Boolean);
  const autoLookSelects = [
    document.getElementById("setting-gemini-auto-look"),
    document.getElementById("setting-gemini-auto-look-mobile"),
  ].filter(Boolean);

  for (const select of autoLookSelects) {
    select.value = String(autoLookSeconds);
    select.addEventListener("change", () => {
      const value = Number(select.value);
      autoLookSeconds = [0, 5, 10, 20].includes(value) ? value : 0;
      try {
        localStorage.setItem(AUTO_LOOK_STORAGE, String(autoLookSeconds));
      } catch {
        // ignore
      }
      for (const node of autoLookSelects) {
        node.value = String(autoLookSeconds);
      }
    });
  }

  for (const input of keyInputs) {
    input.value = getGeminiApiKey();
    input.addEventListener("change", () => {
      setGeminiApiKey(input.value);
      const value = getGeminiApiKey();
      for (const node of keyInputs) {
        node.value = value;
      }
      clearGeminiModelCache();
      for (let i = 0; i < modelSelects.length; i += 1) {
        void refreshGeminiModelPicker(modelSelects[i], modelFallbacks[i]);
      }
    });
  }

  for (let i = 0; i < modelSelects.length; i += 1) {
    const select = modelSelects[i];
    const fallback = modelFallbacks[i];
    if (!select || !fallback) {
      continue;
    }
    fallback.value = getGeminiModelId() || DEFAULT_GEMINI_MODEL;
    select.addEventListener("change", () => {
      setGeminiModelId(select.value);
      clearGeminiModelCache();
    });
    fallback.addEventListener("change", () => {
      setGeminiModelId(fallback.value);
      fallback.value = getGeminiModelId();
      clearGeminiModelCache();
    });
    void refreshGeminiModelPicker(select, fallback);
  }

  syncGeminiSettingsVisibility();
}
